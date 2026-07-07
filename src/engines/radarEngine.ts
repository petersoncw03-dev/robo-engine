export interface RollData {
    id: string;
    timestamp: string;
    color: string;
    roll: number;
}

export function calculateRadar(history: RollData[]) {
    const zonesStats = calculateZones(history);
    const radarStats = calculatePatternsAndCasas(history);

    // Regra dupla: 35% em 1h (250 pedras), fallback 35% em 2h (500 pedras)
    const hasZonasQuentes1h = zonesStats.blocks1h.some((b: any) => b.status === 'ativo' && b.winrate >= 35 && b.total >= 3);
    const hasZonasQuentes2h = !hasZonasQuentes1h && zonesStats.blocks2h.some((b: any) => b.status === 'ativo' && b.winrate >= 35 && b.total >= 5);
    const hasZonasQuentes = hasZonasQuentes1h || hasZonasQuentes2h;
    const hasCasas = radarStats.topCasas?.some((c: any) => c.isLive && c.target === 'B');
    const hasPatterns = [4, 5, 6].some(t => {
        const pat = radarStats.livePatterns[t];
        if (!pat || pat.target !== 'B') return false;
        if (pat.total < 4 || pat.winrate < 60) return false;
        if (pat.wrL !== null && pat.wrL < 50) return false;
        return true;
    });

    let radarPoints = 0;
    if (hasZonasQuentes) radarPoints++;
    if (hasCasas) radarPoints++;
    if (hasPatterns) radarPoints++;

    return {
        radarPoints,
        hasZonasQuentes,
        hasZonasQuentes1h,
        hasZonasQuentes2h,
        hasCasas,
        hasPatterns,
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

        // Calcular ciclos (agrupamento de W/L consecutivos)
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
    const rolls1h = history.slice(-120);  // 1 hora exata (2 pedras/min × 60 min)
    const rolls2h = history.slice(-240);  // 2 horas exatas (2 pedras/min × 120 min)

    const r1h = calcZoneBlocks(rolls1h);
    const r2h = calcZoneBlocks(rolls2h);

    // Exporta os dois para que o radarEngine possa decidir qual usar
    return {
        blocks: r2h.blocks,       // compatibilidade com frontend (usa 2h como padrão)
        blocks1h: r1h.blocks,
        blocks2h: r2h.blocks,
        currentGap: r2h.currentGap
    };
}

function calculatePatternsAndCasas(history: RollData[]) {
    const sliceAmount = -480; // 4 horas exatas (2 pedras/min × 240 min)
    const h2h = history.slice(sliceAmount);
    if (h2h.length === 0) return { livePatterns: {} as any, topCasas: [] as any[] };

    const lastRoll = h2h[h2h.length - 1];
    const lastRollNumber = lastRoll.roll;

    const getC = (r: RollData) => {
        const n = r.roll;
        const col = r.color?.toLowerCase() || '';
        if (col.includes('branco') || n === 0) return 'B';
        if (col.includes('vermelho') || (n >= 1 && n <= 7)) return 'V';
        return 'P';
    };

    const rolls = h2h.map(r => ({ color: getC(r), num: r.roll }));
    const livePatterns: Record<number, any> = {};

    const sizes = [4, 5, 6];
    const targetMargin = 6; // Buscando branco nas próximas 6

    for (const size of sizes) {
        if (rolls.length < size) continue;
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

    // Casas Exatas
    const casasLimit = 10;
    const numEntradas = 6;
    const topCasasExatas: any[] = [];
    
    const ce_stats = Array.from({ length: 15 }, () => ({
        totals: Array(casasLimit).fill(0),
        winB: Array(casasLimit).fill(0),
        saB: Array(casasLimit).fill(0),
        smB: Array(casasLimit).fill(0)
    }));

    for (let i = 0; i < h2h.length; i++) {
        const pastRollNum = h2h[i].roll;
        if (isNaN(pastRollNum)) continue;

        for (let c = 1; c <= casasLimit; c++) {
            const targetStartIdx = i + c;
            if (targetStartIdx < h2h.length) {
                let hasB = false;
                let maxE = Math.min(numEntradas, h2h.length - targetStartIdx);
                if (maxE < 1) continue;
                
                for (let e = 0; e < maxE; e++) {
                    const trC = getC(h2h[targetStartIdx + e]);
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
                const gatilhoIdx = h2h.length - c - e;
                if (gatilhoIdx >= 0 && gatilhoIdx < h2h.length) {
                    if (h2h[gatilhoIdx].roll === num) {
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
