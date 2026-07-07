// Motor IA isolado no backend
// ═══════════════════════════════════════════════════════════════════════
// MOTOR MATEMÁTICO "MINUTOS DA IA" v2.0 — Reescrita Completa
// ═══════════════════════════════════════════════════════════════════════
// Regras fundamentais implementadas:
//   1. Backtester contínuo (sem vazamento de dados do futuro)
//   2. Ciclo de proteção por TEMPO (minuto -2 a +2), não por índice
//   3. Trava de Ouro (creatorTime): branco gerador nunca valida o próprio sinal
//   4. Anti-sombreamento: branco no primeiro alvo mata alvos posteriores do MESMO gerador
//   5. Soma Posterior usa pedra disponível DEPOIS do branco (sem olhar futuro)
// ═══════════════════════════════════════════════════════════════════════

export interface RollData {
  id?: string;
  roll: number;
  color: string;
  timestamp: string;
}

export interface IaSignalStats {
  conf: number;
  winRate: number;
  sa: number;
  sm: number;
  total: number;
  wins: number;
}

export interface StratStat {
  name: string;
  winRate: number;
  wins: number;
  total: number;
  sa: number;
  sm: number;
}

// ─── Tracker de Estatísticas POR HORA ────────────────────────────────
// Conta quantas HORAS distintas (não rolls) tiveram branco em cada
// minuto/linha/coluna. Ex: "em 3 das últimas 6h, o minuto 37 deu branco = 50%"
// Isso é fundamental porque cada minuto tem ~4 rolls, e contar por roll
// daria sempre ~6.7%, nunca atingindo thresholds de 50%/35%/22%.
class HourlyStatTracker {
  // Para cada minuto (0-59): Map<hourKey, hadWhite>
  minuteHours: Map<number, boolean>[] = Array.from({ length: 60 }, () => new Map());
  // Para cada linha (0-5): Map<hourKey, hadWhite>
  rowHours: Map<number, boolean>[] = Array.from({ length: 6 }, () => new Map());
  // Para cada coluna (0-9): Map<hourKey, hadWhite>
  colHours: Map<number, boolean>[] = Array.from({ length: 10 }, () => new Map());
  maxAgeHours: number;

  constructor(hours: number) {
    this.maxAgeHours = hours;
  }

  add(t: number, m: number, isW: boolean) {
    const hourKey = Math.floor(t / 3600000);
    const row = Math.floor(m / 10);
    const col = m % 10;

    // Minuto: registrar a hora e se teve branco
    const prevMin = this.minuteHours[m].get(hourKey);
    this.minuteHours[m].set(hourKey, prevMin || isW);

    // Linha: registrar
    const prevRow = this.rowHours[row].get(hourKey);
    this.rowHours[row].set(hourKey, prevRow || isW);

    // Coluna: registrar
    const prevCol = this.colHours[col].get(hourKey);
    this.colHours[col].set(hourKey, prevCol || isW);
  }

  // Retorna { total: horas com dados, w: horas com branco } para um minuto
  getMinutePct(m: number, currentHourKey: number): number {
    const cutoff = currentHourKey - this.maxAgeHours;
    let total = 0, w = 0;
    for (const [hk, hadW] of this.minuteHours[m]) {
      if (hk > cutoff && hk <= currentHourKey) {
        total++;
        if (hadW) w++;
      }
    }
    return total > 0 ? (w / total) * 100 : 0;
  }

  // Retorna % de horas com branco para uma linha
  getRowPct(row: number, currentHourKey: number): number {
    const cutoff = currentHourKey - this.maxAgeHours;
    let total = 0, w = 0;
    for (const [hk, hadW] of this.rowHours[row]) {
      if (hk > cutoff && hk <= currentHourKey) {
        total++;
        if (hadW) w++;
      }
    }
    return total > 0 ? (w / total) * 100 : 0;
  }

  // Retorna % de horas com branco para uma coluna
  getColPct(col: number, currentHourKey: number): number {
    const cutoff = currentHourKey - this.maxAgeHours;
    let total = 0, w = 0;
    for (const [hk, hadW] of this.colHours[col]) {
      if (hk > cutoff && hk <= currentHourKey) {
        total++;
        if (hadW) w++;
      }
    }
    return total > 0 ? (w / total) * 100 : 0;
  }
}

// ─── Alvo Dinâmico (Pending Target) ────────────────────────────────
// Representa um "míssil" disparado por uma estratégia dinâmica.
interface PendingTarget {
  targetTime: number;    // Timestamp do minuto-alvo
  creatorTime: number;
    creatorIdx: number;
  stratIdx: number;      // Índice da estratégia (4-9)
  groupId: string;       // Identificador do grupo para anti-sombreamento
  priority: number;      // Ordem dentro do grupo (ex: 10m=1, 20m=2)
}

// ─── Sinal Resolvido ───────────────────────────────────────────────
// Um sinal que foi avaliado (o minuto-alvo já passou).
interface ResolvedSignal {
  targetMinute: number;  // Minuto exato do alvo (0-59)
  targetTime: number;    // Timestamp do alvo
  creatorTime: number;   // Timestamp do branco gerador
  stratIdx: number;      // Índice da estratégia
  isWin: boolean;        // Se bateu branco na janela +2/-2
}

const ONE_MIN = 60_000;
const STRAT_NAMES = [
  'Cruzamento Linha x Coluna (3h)',   // 0
  'Quentes (6h - 50%+)',              // 1
  'Quentes (12h - 35%+)',             // 2
  'Quentes (22h - 22%+)',             // 3
  'Minutagem (10/20m)',               // 4
  'Horário Cheio (60/120m)',          // 5
  'Soma Anterior (+Pedra)',           // 6
  'Soma Posterior (+Pedra)',          // 7
  'Fibonacci Espaçado (3/5/8)',       // 8
  'Zero Absoluto (12h - 0%)',         // 9
  'Frequência Dinâmica (6h/12h)',     // 10
  'Fibo Filtrado (Alta Freq)',        // 11
  'Soma Sanduíche (Cores Iguais)'     // 12
];

const latchedAllowedFiltered = new Set<string>();
const latchedAllowedUnfiltered = new Set<string>();
const latchedGridFiltered = new Map<number, { score: number, strats: Set<number> }>();
const latchedGridUnfiltered = new Map<number, { score: number, strats: Set<number> }>();

export function calculateIA(globalData: RollData[], periodHours: number = 12, disabledStrats: Set<number> = new Set(), withMargin: boolean = true, smartFilter: boolean = false) {
    const localDisabledStrats = new Set(disabledStrats);
    const scores = Array(60).fill(0);
    const activeStratsByMin = Array(60).fill(null).map(() => [] as number[]);

    if (!globalData || globalData.length < 50) {
      return {
        scores,
        activeStrats: STRAT_NAMES,
        stats: Array.from({ length: 8 }, (_, i) => ({
          conf: i + 1, winRate: 0, sa: 0, sm: 0, total: 0, wins: 0,
        })),
        stratStats: STRAT_NAMES.map(s => ({ name: s, winRate: 0, wins: 0, total: 0, sa: 0, sm: 0 })),
        disabledStrats,
        history12h: [],
        activeStratsByMin,
        iaApproved: false,
        currentIaScore: 0
      };
    }

    // ════════════════════════════════════════════════════════════════
    // FASE 1: Pré-processar timestamps (evita criar Date repetidamente)
    // ════════════════════════════════════════════════════════════════
    const times: number[] = new Array(globalData.length);
    const minutes: number[] = new Array(globalData.length);
    const isWhite: boolean[] = new Array(globalData.length);

    for (let i = 0; i < globalData.length; i++) {
      const d = new Date(globalData[i].timestamp);
      times[i] = d.getTime();
      minutes[i] = d.getMinutes();
      isWhite[i] = globalData[i].roll === 0;
    }

    const latestTime = times[times.length - 1];
    const backtestCutoff = latestTime - periodHours * 3600000;

    // ════════════════════════════════════════════════════════════════
    // FASE 2: Percorrer dados do passado ao presente
    //   - Alimentar StatTrackers (janelas deslizantes de 3h, 6h, 12h, 22h)
    //   - Gerar/resolver alvos dinâmicos
    //   - Registrar quais estratégias acertaram cada pedra
    // ════════════════════════════════════════════════════════════════
    const s3h = new HourlyStatTracker(3);
    const s6h = new HourlyStatTracker(6);
    const s12h = new HourlyStatTracker(12);
    const s22h = new HourlyStatTracker(22);

    // Alvos dinâmicos pendentes (ainda não resolvidos)
    let pendingTargets: PendingTarget[] = [];

    // Para cada pedra, quais estratégias geraram sinal naquele minuto
    // (usado para calcular scores e confluências)
    const signalsAtRoll: Set<number>[] = new Array(globalData.length);
    for (let i = 0; i < globalData.length; i++) signalsAtRoll[i] = new Set();

    // creatorTime de cada sinal dinâmico por estratégia naquele roll
    const creatorAtRoll: Map<number, number>[] = new Array(globalData.length);
    for (let i = 0; i < globalData.length; i++) creatorAtRoll[i] = new Map();

    // Soma Posterior: quando um branco cai no índice i, precisamos esperar i+1
    // para saber qual pedra veio depois. Armazenamos brancos pendentes aqui.
    let pendingSomaPost: { creatorTime: number; whiteMinuteTime: number; creatorIdx: number }[] = [];

    for (let i = 0; i < globalData.length; i++) {
      const t = times[i];
      const m = minutes[i];
      const w = isWhite[i];

      if (isNaN(m) || m < 0 || m > 59) continue;

      // ── Resolver Soma Posterior pendente ────────────────────────
      // Se havia um branco esperando pela próxima pedra, agora temos ela.
      if (pendingSomaPost.length > 0 && !w) {
        // A pedra atual NÃO é branca — é a "próxima pedra" do branco anterior
        const rollValue = globalData[i].roll;
        if (rollValue >= 2) { // Evita alvo no mesmo minuto (0) ou próximo minuto (1)
          for (const pending of pendingSomaPost) {
            const targetTime = pending.whiteMinuteTime + rollValue * ONE_MIN;
            pendingTargets.push({
              targetTime,
              creatorTime: pending.creatorTime,
              creatorIdx: pending.creatorIdx,
              stratIdx: 7, // Soma Posterior
              groupId: `post_${pending.creatorTime}`,
              priority: 1,
            });
          }
        }
        pendingSomaPost = [];
      }

      // ── Verificar alvos dinâmicos que atingiram este minuto ────
      // Um alvo é "atingido" se o timestamp atual está dentro de ±60s do targetTime
      const newPending: PendingTarget[] = [];
      for (const pt of pendingTargets) {
        // Sinal expirado (mais de 3min de atraso)? Descarta.
        if (t - pt.targetTime > 3 * ONE_MIN) continue;

        // Ainda não chegou na hora do alvo? Mantém pendente.
        if (pt.targetTime - t > ONE_MIN) {
          newPending.push(pt);
          continue;
        }

        // ── Alvo atingido! Registrar no roll atual ───────────────
        signalsAtRoll[i].add(pt.stratIdx);
        creatorAtRoll[i].set(pt.stratIdx, pt.creatorTime);
      }
      pendingTargets = newPending;

      // ── Verificar estratégias ESTÁTICAS para este minuto ───────
      if (t >= backtestCutoff) {
        const row = Math.floor(m / 10);
        const col = m % 10;
        const currentHourKey = Math.floor(t / 3600000);

        // E1: Cruzamento Linha x Coluna (3h) — Linha ≥15% E Coluna ≥15%
        if (!localDisabledStrats.has(0)) {
          const rowPct = s3h.getRowPct(row, currentHourKey);
          const colPct = s3h.getColPct(col, currentHourKey);
          if (rowPct >= 15 && colPct >= 15) {
            signalsAtRoll[i].add(0);
          }
        }

        // E2: Minutos Quentes (6h — ≥50%)
        if (!localDisabledStrats.has(1) && s6h.getMinutePct(m, currentHourKey) >= 50) signalsAtRoll[i].add(1);

        // E3: Minutos Quentes (12h — ≥35%)
        if (!localDisabledStrats.has(2) && s12h.getMinutePct(m, currentHourKey) >= 35) signalsAtRoll[i].add(2);

        // E4: Minutos Quentes (22h — ≥22%)
        if (!localDisabledStrats.has(3) && s22h.getMinutePct(m, currentHourKey) >= 22) signalsAtRoll[i].add(3);

        // E9: Zero Absoluto (12h — 0%)
        if (!localDisabledStrats.has(9)) {
          let hasData = false;
          let hasWhite = false;
          for (const [hk, hadW] of s12h.minuteHours[m]) {
            if (hk > currentHourKey - 12 && hk <= currentHourKey) {
              hasData = true;
              if (hadW) hasWhite = true;
            }
          }
          if (hasData && !hasWhite) signalsAtRoll[i].add(9);
        }
      }

      // ── Se caiu Branco: disparar alvos dinâmicos ───────────────
      if (w) {
        // E5: Minutagem (10/20m)
        if (!localDisabledStrats.has(4)) {
          pendingTargets.push({ targetTime: t + 10 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 4, groupId: `min10_${t}`, priority: 1 });
          pendingTargets.push({ targetTime: t + 20 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 4, groupId: `min10_${t}`, priority: 2 });
        }

        // E6: Horário Cheio (60/120m)
        if (!localDisabledStrats.has(5)) {
          pendingTargets.push({ targetTime: t + 60 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 5, groupId: `min60_${t}`, priority: 1 });
          pendingTargets.push({ targetTime: t + 120 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 5, groupId: `min60_${t}`, priority: 2 });
        }

        // E8: Fibonacci (3/5/8m)
        if (!localDisabledStrats.has(8)) {
          pendingTargets.push({ targetTime: t + 3 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 8, groupId: `fib_${t}`, priority: 1 });
          pendingTargets.push({ targetTime: t + 5 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 8, groupId: `fib_${t}`, priority: 2 });
          pendingTargets.push({ targetTime: t + 8 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 8, groupId: `fib_${t}`, priority: 3 });
        }

        // E7: Soma Anterior
        if (!localDisabledStrats.has(6) && i > 0 && !isWhite[i - 1]) {
          const prevRoll = globalData[i - 1].roll;
          if (prevRoll >= 2) {
            pendingTargets.push({ targetTime: t + prevRoll * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 6, groupId: `ant_${t}`, priority: 1, });
          }
        }
        // E10: Frequência Dinâmica (6h/12h)
        if (!localDisabledStrats.has(10)) {
          let w6h = 0; let w12h = 0;
          for (let j = i - 1; j >= 0; j--) {
            const dt = t - times[j];
            if (dt > 12 * 3600000) break;
            if (isWhite[j]) { w12h++; if (dt <= 6 * 3600000) w6h++; }
          }
          const avg6 = Math.round((6 * 60) / Math.max(1, w6h));
          const avg12 = Math.round((12 * 60) / Math.max(1, w12h));
          if (avg6 > 1) pendingTargets.push({ targetTime: t + avg6 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 10, groupId: `freq_${t}`, priority: 1 });
          if (avg12 > 1 && avg12 !== avg6) pendingTargets.push({ targetTime: t + avg12 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 10, groupId: `freq_${t}`, priority: 2 });
        }

        // E11: Fibo Filtrado (Alta Freq)
        if (!localDisabledStrats.has(11)) {
          let whitesLastHour = 0;
          for (let j = i - 1; j >= 0; j--) {
            if (t - times[j] > 60 * ONE_MIN) break;
            if (isWhite[j]) whitesLastHour++;
          }
          if (whitesLastHour >= 5) {
            [3, 5, 8].forEach((f, idx) => {
              pendingTargets.push({ targetTime: t + f * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 11, groupId: `fibfilt_${t}`, priority: idx + 1 });
            });
          }
        }

        // E8: Soma Posterior
        if (!localDisabledStrats.has(7)) {
          pendingSomaPost.push({ creatorTime: t, creatorIdx: i, whiteMinuteTime: t });
        }
      } else if (!localDisabledStrats.has(12) && i >= 2 && isWhite[i - 1] && !isWhite[i - 2]) {
          const prevRoll = globalData[i - 2].roll;
          const postRoll = globalData[i].roll;
          if (((prevRoll >= 1 && prevRoll <= 7 && postRoll >= 1 && postRoll <= 7) || (prevRoll >= 8 && prevRoll <= 14 && postRoll >= 8 && postRoll <= 14)) && (prevRoll + postRoll) >= 2) {
              pendingTargets.push({ targetTime: times[i - 1] + (prevRoll + postRoll) * ONE_MIN, creatorTime: times[i - 1], creatorIdx: i - 1, stratIdx: 12, groupId: `sandcor_${times[i - 1]}`, priority: 1 });
          }
      }

      s3h.add(t, m, w);
      s6h.add(t, m, w);
      s12h.add(t, m, w);
      s22h.add(t, m, w);
    }
    
    const isMinuteInWindow = (rollMin: number, targetMin: number): boolean => {
      if (!withMargin) return rollMin === targetMin;
      const diff = Math.abs(rollMin - targetMin);
      return diff <= 1 || diff >= 59;
    };

    const checkCycleWin = (targetIdx: number, creatorTime: number): boolean => {
      const targetT = times[targetIdx];
      const targetMin = minutes[targetIdx];
      const windowRange = withMargin ? 1.5 : 0.5;
      const windowStart = targetT - windowRange * ONE_MIN;
      const windowEnd = targetT + windowRange * ONE_MIN;

      for (let j = targetIdx; j >= 0 && times[j] >= windowStart; j--) {
        if (isWhite[j] && times[j] > creatorTime && isMinuteInWindow(minutes[j], targetMin)) return true;
      }
      for (let j = targetIdx + 1; j < globalData.length && times[j] <= windowEnd; j++) {
        if (isWhite[j] && times[j] > creatorTime && isMinuteInWindow(minutes[j], targetMin)) return true;
      }
      return false;
    };

    const signalAllowed = new Set<string>();
    const currentGhostStats = STRAT_NAMES.map(() => ({ sa: 0, sm: 0, wr: 0 }));

    for (let sIdx = 0; sIdx < STRAT_NAMES.length; sIdx++) {
      let currentSa = 0; let maxSa = 0;
      const history2h: { t: number, won: boolean }[] = [];
      let lastEvalEnd = -1;

      for (let i = 0; i < globalData.length; i++) {
        if (!signalsAtRoll[i].has(sIdx) || i <= lastEvalEnd) continue;
        const t = times[i];
        while (history2h.length > 0 && t - history2h[0].t > 2 * 3600000) history2h.shift();
        const cTime = creatorAtRoll[i].get(sIdx) || 0;
        const latchTime = Math.max(t - 3 * 60000, cTime);
        let validTotal = 0; let validWins = 0; let simSa = 0; let simMaxSa = 0;
        for (const h of history2h) {
          if (h.t <= latchTime && h.t > latchTime - 2 * 3600000) { validTotal++; if (h.won) validWins++; }
          if (h.won) simSa = 0; else { simSa++; if (simSa > simMaxSa) simMaxSa = simSa; }
        }
        const wr = validTotal >= 5 ? (validWins / validTotal) * 100 : 0;
        let allowed = (smartFilter && ![1, 2, 12].includes(sIdx)) ? (wr >= 40 || (simMaxSa >= 4 && simSa >= Math.floor(simMaxSa * 0.8))) : true;
        if (allowed) signalAllowed.add(`${i}_${sIdx}`);
        const won = checkCycleWin(i, cTime);
        history2h.push({ t, won });
        if (won) currentSa = 0; else { currentSa++; if (currentSa > maxSa) maxSa = currentSa; }
        const windowEnd = t + (withMargin ? 1.5 : 0.5) * ONE_MIN;
        lastEvalEnd = i;
        for (let j = i + 1; j < globalData.length && times[j] <= windowEnd; j++) {
          if (signalsAtRoll[j].has(sIdx)) { lastEvalEnd = j; if (allowed) signalAllowed.add(`${j}_${sIdx}`); }
        }
      }
      const total2h = history2h.length;
      const wins2h = history2h.filter(h => h.won).length;
      currentGhostStats[sIdx] = { sa: currentSa, sm: maxSa, wr: total2h >= 5 ? (wins2h / total2h) * 100 : 0 };
    }

    const isStratAllowedNow = (sIdx: number, useFilter: boolean) => {
      if (localDisabledStrats.has(sIdx)) return false;
      if (!useFilter || [1, 2, 12].includes(sIdx)) return true;
      const g = currentGhostStats[sIdx];
      return g.wr >= 40 || (g.sm >= 4 && g.sa >= Math.floor(g.sm * 0.8));
    };

    const finalScoresResult = Array(60).fill(0);
    const finalStratsResult = Array(60).fill(null).map(() => [] as number[]);
    const latestHourKey = Math.floor(latestTime / 3600000);
    const latestMinuteAbsolute = Math.floor(latestTime / 60000);
    const latestM = latestMinuteAbsolute % 60;

    for (const useFilter of [false, true]) {
        const rawScores = Array(60).fill(0);
        const rawStrats = Array(60).fill(null).map(() => new Set<number>());
        for (let m = 0; m < 60; m++) {
          const row = Math.floor(m / 10); const col = m % 10;
          if (isStratAllowedNow(0, useFilter) && s3h.getRowPct(row, latestHourKey) >= 15 && s3h.getColPct(col, latestHourKey) >= 15) { rawScores[m]++; rawStrats[m].add(0); }
          if (isStratAllowedNow(1, useFilter) && s6h.getMinutePct(m, latestHourKey) >= 50) { rawScores[m]++; rawStrats[m].add(1); }
          if (isStratAllowedNow(2, useFilter) && s12h.getMinutePct(m, latestHourKey) >= 35) { rawScores[m]++; rawStrats[m].add(2); }
          if (isStratAllowedNow(3, useFilter) && s22h.getMinutePct(m, latestHourKey) >= 22) { rawScores[m]++; rawStrats[m].add(3); }
        }
        for (const pt of pendingTargets) {
            let isAllowed = isStratAllowedNow(pt.stratIdx, useFilter);
            if (isAllowed) {
              const targetMin = new Date(pt.targetTime).getMinutes();
              rawScores[targetMin]++; rawStrats[targetMin].add(pt.stratIdx);
            }
        }
        if (useFilter === smartFilter) {
            for (let m = 0; m < 60; m++) { finalScoresResult[m] = rawScores[m]; finalStratsResult[m] = Array.from(rawStrats[m]); }
        }
    }

    const stratStats: StratStat[] = STRAT_NAMES.map(name => ({ name, winRate: 0, wins: 0, total: 0, sa: 0, sm: 0 }));
    for (let sIdx = 0; sIdx < STRAT_NAMES.length; sIdx++) {
      let currentSa = 0; let maxSa = 0; let wins = 0; let total = 0; let lastEvalEnd = -1;
      for (let i = 0; i < globalData.length; i++) {
        if (times[i] < backtestCutoff || i <= lastEvalEnd || !signalAllowed.has(`${i}_${sIdx}`)) continue;
        const won = checkCycleWin(i, creatorAtRoll[i].get(sIdx) || 0);
        total++; if (won) { wins++; currentSa = 0; } else { currentSa++; if (currentSa > maxSa) maxSa = currentSa; }
        const windowEnd = times[i] + (withMargin ? 1.5 : 0.5) * ONE_MIN;
        lastEvalEnd = i;
        for (let j = i + 1; j < globalData.length && times[j] <= windowEnd; j++) if (signalAllowed.has(`${j}_${sIdx}`)) lastEvalEnd = j; else break;
      }
      stratStats[sIdx] = { name: STRAT_NAMES[sIdx], wins, total, winRate: total > 0 ? (wins / total) * 100 : 0, sa: currentSa, sm: maxSa };
    }

    const stats: IaSignalStats[] = [];
    for (let confLvl = 1; confLvl <= 8; confLvl++) {
      let currentSa = 0; let maxSa = 0; let wins = 0; let total = 0; let lastEvalEnd = -1;
      for (let i = 0; i < globalData.length; i++) {
        if (times[i] < backtestCutoff || i <= lastEvalEnd) continue;
        const filteredSignals = Array.from(signalsAtRoll[i]).filter(s => signalAllowed.has(`${i}_${s}`));
        if (filteredSignals.length < confLvl) continue;
        let maxCreator = 0; for (const s of filteredSignals) { const ct = creatorAtRoll[i].get(s) || 0; if (ct > maxCreator) maxCreator = ct; }
        const won = checkCycleWin(i, maxCreator);
        total++; if (won) { wins++; currentSa = 0; } else { currentSa++; if (currentSa > maxSa) maxSa = currentSa; }
        const windowEnd = times[i] + (withMargin ? 1.5 : 0.5) * ONE_MIN;
        lastEvalEnd = i;
        for (let j = i + 1; j < globalData.length && times[j] <= windowEnd; j++) {
            const fJ = Array.from(signalsAtRoll[j]).filter(s => signalAllowed.has(`${j}_${s}`));
            if (fJ.length >= confLvl) lastEvalEnd = j; else break;
        }
      }
      stats.push({ conf: confLvl, total, wins, winRate: total > 0 ? (wins / total) * 100 : 0, sa: currentSa, sm: maxSa });
    }

    const history12h = Array(60).fill(null).map(() => [] as { hourString: string, hit: boolean }[]);
    for (let m = 0; m < 60; m++) {
      for (let hOff = 0; hOff < 12; hOff++) {
         const targetHk = latestHourKey - hOff;
         const hit = s12h.minuteHours[m]?.get(targetHk) || false;
         const date = new Date(targetHk * 3600000);
         history12h[m].push({ hourString: date.getHours().toString().padStart(2, '0') + 'h', hit });
      }
    }

    const currentMin = new Date(globalData[globalData.length - 1].timestamp).getMinutes();
    const score1 = finalScoresResult[(currentMin + 1) % 60] || 0;
    const score2 = finalScoresResult[(currentMin + 2) % 60] || 0;
    
    return {
      scores: finalScoresResult,
      activeStrats: STRAT_NAMES,
      stats,
      stratStats,
      history12h,
      activeStratsByMin: finalStratsResult,
      iaApproved: score1 >= 2 || score2 >= 2,
      currentIaScore: Math.max(score1, score2)
    };
}
