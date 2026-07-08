export interface RollData {
    id: string;
    timestamp: string;
    color: string;
    roll: number;
}

export function calculateRadar(history: RollData[]) {
    const zonesStats = calculateZones(history);
    const radarStats = calculatePatternsAndCasas(history);

    const hasZonasQuentes1h = zonesStats.blocks1h.some((b: any) => b.status === 'ativo' && b.winrate >= 35 && b.total >= 3);
    const hasZonasQuentes2h = !hasZonasQuentes1h && zonesStats.blocks2h.some((b: any) => b.status === 'ativo' && b.winrate >= 35 && b.total >= 5);
    const hasZonasQuentes = hasZonasQuentes1h || hasZonasQuentes2h;
    
    // Regra Casa Exata: 1 ponto se winrate > 45%
    const hasCasas = radarStats.topCasas?.some((c: any) => c.isLive && c.target === 'B' && c.winrate > 45);

    // Regras Padrões de Cores
    let padroesAllAcima50 = true;
    let sumAvgs = 0;
    let count = 0;
    
    for (const size of [4, 5, 6]) {
        const pat = radarStats.livePatterns[size];
        if (!pat) {
            padroesAllAcima50 = false;
            break;
        }
        if (pat.winrate <= 50) {
            padroesAllAcima50 = false;
        }
        let wrL = pat.wrL !== null ? pat.wrL : pat.winrate;
        let avg = (pat.winrate + wrL) / 2;
        sumAvgs += avg;
        count++;
    }

    let hasPatterns1Pt = false;
    let hasPatterns2Pts = false;
    
    if (count === 3 && padroesAllAcima50) {
        hasPatterns1Pt = true;
        let totalAvg = sumAvgs / 3;
        if (totalAvg > 80) {
            hasPatterns2Pts = true;
            hasPatterns1Pt = false; // Substitui o ponto 1 pelo 2
        }
    }

    let radarPoints = 0;
    if (hasZonasQuentes) radarPoints += 1;
    if (hasCasas) radarPoints += 1;
    if (hasPatterns2Pts) radarPoints += 2;
    else if (hasPatterns1Pt) radarPoints += 1;

    return {
        radarPoints,
        hasZonasQuentes,
        hasCasas,
        hasPatterns1Pt,
        hasPatterns2Pts,
        radarStats,
        zonesStats
    };
}

function calcZoneBlocks(rolls: RollData[]) {
    const whiteIndices = rolls.reduce((acc, r, i) => {
        if (r.color?.toLowerCase().includes('branco') || r.roll === 0) acc.push(i);
        return acc;
    }, [] as number[]);

    if (whiteIndices.length === 0) return { blocks: [], currentGap: rolls.length };

    const gaps: number[] = [];
    for (let i = 1; i < whiteIndices.length; i++) {
        gaps.push(whiteIndices[i] - whiteIndices[i - 1]);
    }

    const currentGap = rolls.length - 1 - whiteIndices[whiteIndices.length - 1];
    const nextEnt = currentGap + 1;

    const zones = [
        { label: '1 a 5', s: 1, e: 5 },
        { label: '6 a 10', s: 6, e: 10 },
        { label: '11 a 15', s: 11, e: 15 },
        { label: '16 a 20', s: 16, e: 20 },
        { label: '21 a 25', s: 21, e: 25 },
        { label: '26 a 30', s: 26, e: 30 }
    ];

    const blocks = zones.map(z => {
        let wins = 0;
        let losses = 0;
        const outcomes: ('W' | 'L')[] = [];

        for (const g of gaps) {
            if (g >= z.s && g <= z.e) { wins++; outcomes.push('W'); }
            else if (g > z.e) { losses++; outcomes.push('L'); }
        }
        if (currentGap >= z.e) { losses++; outcomes.push('L'); }

        const cycles: { type: 'W' | 'L', count: number }[] = [];
        for (const out of outcomes) {
            if (cycles.length === 0) {
                cycles.push({ type: out, count: 1 });
            } else {
                const last = cycles[cycles.length - 1];
                if (last.type === out) last.count++;
                else cycles.push({ type: out, count: 1 });
            }
        }

        const total = wins + losses;
        const winrate = total > 0 ? (wins / total) * 100 : 0;
        let status = 'aguardando';
        if (nextEnt >= z.s && nextEnt <= z.e) status = 'ativo';
        else if (nextEnt > z.e) status = 'passou';

        return { ...z, wins, losses, total, winrate, status, cycles: cycles.slice(-7) };
    });

    return { blocks, currentGap };
}

function calculateZones(history: RollData[]) {
    const rolls1h = history.slice(-120);
    const rolls2h = history.slice(-240);
    const r1h = calcZoneBlocks(rolls1h);
    const r2h = calcZoneBlocks(rolls2h);
    return {
        blocks: r2h.blocks,
        blocks1h: r1h.blocks,
        blocks2h: r2h.blocks,
        currentGap: r2h.currentGap
    };
}

function calculatePatternsAndCasas(history: RollData[]) {
    const getC = (r: RollData) => {
        const n = r.roll;
        const col = r.color?.toLowerCase() || '';
        if (col.includes('branco') || n === 0) return 'B';
        if (col.includes('vermelho') || (n >= 1 && n <= 7)) return 'V';
        return 'P';
    };

    const hFull = history;
    if (hFull.length === 0) return { livePatterns: {} as any, topCasas: [] as any[] };

    const lastRoll = hFull[hFull.length - 1];
    const lastRollNumber = lastRoll.roll;

    const livePatterns: Record<number, any> = {};
    const targetMargin = 6;

    const sizesConfig = [
        { size: 4, limit: 480 },
        { size: 5, limit: 720 },
        { size: 6, limit: 1200 }
    ];

    for (const conf of sizesConfig) {
        const size = conf.size;
        const sliceAmount = conf.limit;
        
        const hSlice = history.slice(-sliceAmount);
        if (hSlice.length < size) continue;

        const rolls = hSlice.map(r => ({ color: getC(r), num: r.roll }));
        const patMap = new Map<string, any>();
        
        const liveSlice = rolls.slice(-size);
        const livePatStr = liveSlice.map(r => r.color).join('');

        for (let i = 0; i <= rolls.length - size - targetMargin; i++) {
            const patStr = rolls.slice(i, i + size).map(r => r.color).join('');
            const patLastNum = rolls[i + size - 1].num;

            if (!patMap.has(patStr)) {
                patMap.set(patStr, { win: 0, loss: 0, winL: 0, lossL: 0 });
            }
            const data = patMap.get(patStr)!;

            let hitB = false;
            for (let m = 0; m < targetMargin; m++) {
                if (rolls[i + size + m].color === 'B') hitB = true;
            }

            if (hitB) data.win++; else data.loss++;
            if (patLastNum === lastRollNumber) {
                if (hitB) data.winL++; else data.lossL++;
            }
        }

        for (const [patStr, data] of patMap.entries()) {
            if (patStr === livePatStr) {
                const total = data.win + data.loss;
                const winrate = total > 0 ? (data.win / total) * 100 : 0;
                const wrL = (data.winL + data.lossL > 0) ? (data.winL / (data.winL + data.lossL)) * 100 : null;
                livePatterns[size] = { target: 'B', winrate, wrL, total };
            }
        }
    }

    // Casas Exatas usa o histórico base (ex: 480 ou 720) para não demorar tanto, vamos usar 720 (6 horas)
    const hCasas = history.slice(-720);
    const casasLimit = 10;
    const numEntradas = 6;
    const topCasasExatas: any[] = [];
    
    const ce_stats = Array.from({ length: 15 }, () => ({
        totals: Array(casasLimit).fill(0),
        winB: Array(casasLimit).fill(0),
        saB: Array(casasLimit).fill(0),
        smB: Array(casasLimit).fill(0)
    }));

    for (let i = 0; i < hCasas.length; i++) {
        const pastRollNum = hCasas[i].roll;
        if (isNaN(pastRollNum)) continue;

        for (let c = 1; c <= casasLimit; c++) {
            const targetStartIdx = i + c;
            if (targetStartIdx < hCasas.length) {
                let hasB = false;
                let maxE = Math.min(numEntradas, hCasas.length - targetStartIdx);
                if (maxE < 1) continue;
                
                for (let e = 0; e < maxE; e++) {
                    const trC = getC(hCasas[targetStartIdx + e]);
                    if (trC === 'B') hasB = true;
                }

                const windowClosed = maxE === numEntradas;
                if (hasB || windowClosed) {
                    ce_stats[pastRollNum].totals[c-1]++;
                    if (hasB) {
                        ce_stats[pastRollNum].saB[c-1] = 0;
                        ce_stats[pastRollNum].winB[c-1]++;
                    } else {
                        ce_stats[pastRollNum].saB[c-1]++;
                        if (ce_stats[pastRollNum].saB[c-1] > ce_stats[pastRollNum].smB[c-1]) {
                            ce_stats[pastRollNum].smB[c-1] = ce_stats[pastRollNum].saB[c-1];
                        }
                    }
                }
            }
        }
    }

    for (let num = 0; num < 15; num++) {
        for (let c = 1; c <= casasLimit; c++) {
            let isLive = false;
            for (let e = 0; e < numEntradas; e++) {
                const gatilhoIdx = hCasas.length - c - e;
                if (gatilhoIdx >= 0 && gatilhoIdx < hCasas.length) {
                    if (hCasas[gatilhoIdx].roll === num) {
                        isLive = true;
                        break;
                    }
                }
            }
            
            const total = ce_stats[num].totals[c-1];
            if (total >= 5) {
                const win = ce_stats[num].winB[c-1];
                const sa = ce_stats[num].saB[c-1];
                const winrate = (win / total) * 100;
                topCasasExatas.push({ num, casa: c, target: 'B', winrate, win, loss: total - win, sa, isLive });
            }
        }
    }

    const bestPerNum = new Map();
    for (const c of topCasasExatas) {
        if (!bestPerNum.has(c.num)) {
            bestPerNum.set(c.num, c);
        } else {
            const existing = bestPerNum.get(c.num);
            if (c.winrate > existing.winrate || (c.winrate === existing.winrate && c.sa < existing.sa)) {
                bestPerNum.set(c.num, c);
            }
        }
    }
    
    const diversifiedTop = Array.from(bestPerNum.values());
    diversifiedTop.sort((a, b) => b.winrate - a.winrate || a.sa - b.sa || b.win - a.win);
    const topCasas = diversifiedTop.slice(0, 5);

    return { livePatterns, topCasas };
}
