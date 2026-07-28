// Motor IA isolado no backend
// ═══════════════════════════════════════════════════════════════════════
// MOTOR MATEMÁTICO "MINUTOS DA IA" v2.0
// ═══════════════════════════════════════════════════════════════════════

export interface RollData {
  id?: string;
  roll: number;
  color?: string;
  timestamp: string | number;
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

export interface WinrateFilterConfig {
  enabled: boolean;
  minWr: number;
  maxWr: number;
  hours: number;
}

class HourlyStatTracker {
  minuteHours: Map<number, boolean>[] = Array.from({ length: 60 }, () => new Map());
  rowHours: Map<number, boolean>[] = Array.from({ length: 6 }, () => new Map());
  colHours: Map<number, boolean>[] = Array.from({ length: 10 }, () => new Map());
  maxAgeHours: number;

  constructor(hours: number) {
    this.maxAgeHours = hours;
  }

  add(t: number, m: number, isW: boolean) {
    const hourKey = Math.floor(t / 3600000);
    const row = Math.floor(m / 10);
    const col = m % 10;

    const prevMin = this.minuteHours[m].get(hourKey);
    this.minuteHours[m].set(hourKey, prevMin || isW);

    const prevRow = this.rowHours[row].get(hourKey);
    this.rowHours[row].set(hourKey, prevRow || isW);

    const prevCol = this.colHours[col].get(hourKey);
    this.colHours[col].set(hourKey, prevCol || isW);
  }

  getMinutePct(m: number, currentHourKey: number, customHours?: number, withMargin: boolean = true): number {
    const hoursToUse = customHours && customHours > 0 ? customHours : this.maxAgeHours;
    if (hoursToUse <= 0) return 0;

    const mPrev = (m - 1 + 60) % 60;
    const mNext = (m + 1) % 60;

    let w = 0;
    for (let hk = currentHourKey - hoursToUse + 1; hk <= currentHourKey; hk++) {
      const hadW = withMargin
        ? ((this.minuteHours[mPrev].get(hk) || false) ||
           (this.minuteHours[m].get(hk) || false) ||
           (this.minuteHours[mNext].get(hk) || false))
        : (this.minuteHours[m].get(hk) || false);
      if (hadW) w++;
    }

    return (w / hoursToUse) * 100;
  }

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

interface PendingTarget {
  targetTime: number;
  creatorTime: number;
  creatorIdx: number;
  stratIdx: number;
  groupId: string;
  priority: number;
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
  'Soma Sanduíche (Cores Iguais)',    // 12
  'Momentum Gaps (Chuva de Brancos)',// 13
  'Matriz de Markov (3ª Ordem)'       // 14
];

export function calculateIA(
  globalData: RollData[],
  periodHours: number = 12,
  disabledStrats: Set<number> = new Set(),
  withMargin: boolean = true,
  smartFilter: boolean = false,
  microFilter?: WinrateFilterConfig,
  macroFilter?: WinrateFilterConfig,
  minutoFilter?: WinrateFilterConfig
) {
  const defaultDisabled = new Set([4, 5, 6, 8, 9, 10, 11, 12]);
  const localDisabledStrats = disabledStrats !== undefined && disabledStrats !== null
    ? new Set(disabledStrats)
    : defaultDisabled;

  const scores = Array(60).fill(0);
  const activeStratsByMin = Array(60).fill(null).map(() => [] as number[]);

  if (!globalData || globalData.length < 50) {
    return {
      scores,
      activeStratsByMin,
      disabledStrats: localDisabledStrats,
      activeStrats: STRAT_NAMES,
      stats: Array.from({ length: 8 }, (_, i) => ({
        conf: i + 1, winRate: 0, sa: 0, sm: 0, total: 0, wins: 0,
      })),
      stratStats: STRAT_NAMES.map(name => ({
        name, winRate: 0, wins: 0, total: 0, sa: 0, sm: 0
      })),
      currentHourTracker12h: new HourlyStatTracker(12)
    };
  }

  const times: number[] = new Array(globalData.length);
  const minutes: number[] = new Array(globalData.length);
  const isWhite: boolean[] = new Array(globalData.length);

  for (let i = 0; i < globalData.length; i++) {
    const d = new Date(globalData[i].timestamp);
    times[i] = d.getTime();
    minutes[i] = d.getMinutes();
    const rVal = Number(globalData[i]?.roll);
    const cStr = String(globalData[i]?.color || '').toUpperCase();
    isWhite[i] = (!isNaN(rVal) && rVal === 0) || cStr === 'BRANCO' || cStr === 'WHITE' || cStr === 'B' || cStr === 'W' || cStr === '0';
  }

  const latestTime = times[times.length - 1];
  const backtestCutoff = latestTime - periodHours * 3600000;

  const s3h = new HourlyStatTracker(3);
  const s6h = new HourlyStatTracker(6);
  const s12h = new HourlyStatTracker(12);
  const s22h = new HourlyStatTracker(22);

  let pendingTargets: PendingTarget[] = [];
  const signalsAtRoll: Set<number>[] = Array.from({ length: globalData.length }, () => new Set());
  const creatorAtRoll: Map<number, number>[] = Array.from({ length: globalData.length }, () => new Map());
  let pendingSomaPost: { creatorTime: number; whiteMinuteTime: number; creatorIdx: number }[] = [];

  for (let i = 0; i < globalData.length; i++) {
    const t = times[i];
    const m = minutes[i];
    const w = isWhite[i];

    if (isNaN(m) || m < 0 || m > 59) continue;

    if (pendingSomaPost.length > 0 && !w) {
      const rollValue = Number(globalData[i]?.roll || 0);
      if (rollValue >= 2) {
        for (const pending of pendingSomaPost) {
          const targetTime = pending.whiteMinuteTime + rollValue * ONE_MIN;
          pendingTargets.push({
            targetTime,
            creatorTime: pending.creatorTime,
            creatorIdx: pending.creatorIdx,
            stratIdx: 7,
            groupId: `post_${pending.creatorTime}`,
            priority: 1,
          });
        }
      }
      pendingSomaPost = [];
    }

    const newPending: PendingTarget[] = [];
    for (const pt of pendingTargets) {
      const diff = t - pt.targetTime;
      if (pt.targetTime - t > 2 * ONE_MIN) {
        newPending.push(pt);
        continue;
      }
      if (Math.abs(diff) <= 2 * ONE_MIN) {
        signalsAtRoll[i].add(pt.stratIdx);
        creatorAtRoll[i].set(pt.stratIdx, pt.creatorTime);
        newPending.push(pt);
        continue;
      }
    }
    pendingTargets = newPending;

    if (t >= backtestCutoff) {
      const row = Math.floor(m / 10);
      const col = m % 10;
      const currentHourKey = Math.floor(t / 3600000);

      if (!localDisabledStrats.has(0)) {
        const rowPct = s3h.getRowPct(row, currentHourKey);
        const colPct = s3h.getColPct(col, currentHourKey);
        if (rowPct >= 66 && colPct >= 66) signalsAtRoll[i].add(0);
      }

      if (!localDisabledStrats.has(1) && s6h.getMinutePct(m, currentHourKey) >= 50) signalsAtRoll[i].add(1);
      if (!localDisabledStrats.has(2) && s12h.getMinutePct(m, currentHourKey) >= 35) signalsAtRoll[i].add(2);
      if (!localDisabledStrats.has(3) && s22h.getMinutePct(m, currentHourKey) >= 22) signalsAtRoll[i].add(3);

      if (!localDisabledStrats.has(9)) {
        let hasData = false, hasWhite = false;
        for (const [hk, hadW] of s12h.minuteHours[m]) {
          if (hk > currentHourKey - 12 && hk <= currentHourKey) {
            hasData = true;
            if (hadW) hasWhite = true;
          }
        }
        if (hasData && !hasWhite) signalsAtRoll[i].add(9);
      }
    }

    if (w) {
      const gId10 = `min10_${t}`;
      const gId60 = `min60_${t}`;
      const gIdFib = `fib_${t}`;

      if (!localDisabledStrats.has(4)) {
        pendingTargets.push({ targetTime: t + 10 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 4, groupId: gId10, priority: 1 });
        pendingTargets.push({ targetTime: t + 20 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 4, groupId: gId10, priority: 2 });
      }

      if (!localDisabledStrats.has(5)) {
        pendingTargets.push({ targetTime: t + 60 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 5, groupId: gId60, priority: 1 });
        pendingTargets.push({ targetTime: t + 120 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 5, groupId: gId60, priority: 2 });
      }

      if (!localDisabledStrats.has(8)) {
        pendingTargets.push({ targetTime: t + 3 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 8, groupId: gIdFib, priority: 1 });
        pendingTargets.push({ targetTime: t + 5 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 8, groupId: gIdFib, priority: 2 });
        pendingTargets.push({ targetTime: t + 8 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 8, groupId: gIdFib, priority: 3 });
      }

      if (!localDisabledStrats.has(6) && i > 0 && !isWhite[i - 1]) {
        const prevRoll = Number(globalData[i - 1]?.roll || 0);
        if (prevRoll >= 2) {
          pendingTargets.push({ targetTime: t + prevRoll * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 6, groupId: `ant_${t}`, priority: 1 });
        }
      }

      if (!localDisabledStrats.has(10)) {
        let w6h = 0, w12h = 0;
        for (let j = i - 1; j >= 0; j--) {
          const dt = t - times[j];
          if (dt > 12 * 3600000) break;
          if (isWhite[j]) {
            w12h++;
            if (dt <= 6 * 3600000) w6h++;
          }
        }
        const avg6 = Math.round((6 * 60) / Math.max(1, w6h));
        const avg12 = Math.round((12 * 60) / Math.max(1, w12h));
        if (avg6 > 1) pendingTargets.push({ targetTime: t + avg6 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 10, groupId: `freq_${t}`, priority: 1 });
        if (avg12 > 1 && avg12 !== avg6) pendingTargets.push({ targetTime: t + avg12 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 10, groupId: `freq_${t}`, priority: 2 });
      }

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

      if (!localDisabledStrats.has(13)) {
        let whites: number[] = [];
        for (let j = i; j >= 0 && whites.length < 4; j--) {
          if (isWhite[j]) whites.push(times[j]);
        }
        if (whites.length >= 4) {
          const g1 = Math.round((whites[2] - whites[3]) / ONE_MIN);
          const g2 = Math.round((whites[1] - whites[2]) / ONE_MIN);
          const g3 = Math.round((whites[0] - whites[1]) / ONE_MIN);
          if (g3 < g2 && g2 < g1 && g3 <= 15) {
            const proj = Math.max(2, g3 + Math.round((g3 - g1) / 2));
            pendingTargets.push({ targetTime: t + proj * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 13, groupId: `mom_${t}`, priority: 1 });
          }
        }
      }

      if (!localDisabledStrats.has(14) && i >= 3) {
        const c3 = isWhite[i-3] ? 'W' : (Number(globalData[i-3]?.roll) >= 1 && Number(globalData[i-3]?.roll) <= 7 ? 'R' : 'B');
        const c2 = isWhite[i-2] ? 'W' : (Number(globalData[i-2]?.roll) >= 1 && Number(globalData[i-2]?.roll) <= 7 ? 'R' : 'B');
        const c1 = isWhite[i-1] ? 'W' : (Number(globalData[i-1]?.roll) >= 1 && Number(globalData[i-1]?.roll) <= 7 ? 'R' : 'B');
        const stateKey = `${c3}_${c2}_${c1}`;
        let stateCount = 0, whiteHits = 0;
        for (let j = i - 1; j >= Math.max(0, i - 1500); j--) {
          if (j >= 3) {
            const p3 = isWhite[j-3] ? 'W' : (Number(globalData[j-3]?.roll) >= 1 && Number(globalData[j-3]?.roll) <= 7 ? 'R' : 'B');
            const p2 = isWhite[j-2] ? 'W' : (Number(globalData[j-2]?.roll) >= 1 && Number(globalData[j-2]?.roll) <= 7 ? 'R' : 'B');
            const p1 = isWhite[j-1] ? 'W' : (Number(globalData[j-1]?.roll) >= 1 && Number(globalData[j-1]?.roll) <= 7 ? 'R' : 'B');
            if (`${p3}_${p2}_${p1}` === stateKey) {
              stateCount++;
              if (isWhite[j]) whiteHits++;
            }
          }
        }
        if (stateCount >= 5 && (whiteHits / stateCount) >= 0.10) {
          pendingTargets.push({ targetTime: t + 3 * ONE_MIN, creatorTime: t, creatorIdx: i, stratIdx: 14, groupId: `markov_${t}`, priority: 1 });
        }
      }

      if (!localDisabledStrats.has(7)) pendingSomaPost.push({ creatorTime: t, creatorIdx: i, whiteMinuteTime: t });
    } else {
      if (!localDisabledStrats.has(12) && i >= 2) {
        if (isWhite[i - 1] && !isWhite[i - 2]) {
          const prevRoll = Number(globalData[i - 2]?.roll || 0);
          const postRoll = Number(globalData[i]?.roll || 0);
          const isPrevRed = prevRoll >= 1 && prevRoll <= 7;
          const isPrevBlack = prevRoll >= 8 && prevRoll <= 14;
          const isPostRed = postRoll >= 1 && postRoll <= 7;
          const isPostBlack = postRoll >= 8 && postRoll <= 14;
          if ((isPrevRed && isPostRed) || (isPrevBlack && isPostBlack)) {
            const soma = prevRoll + postRoll;
            if (soma >= 2) {
              pendingTargets.push({ targetTime: times[i - 1] + soma * ONE_MIN, creatorTime: times[i - 1], creatorIdx: i - 1, stratIdx: 12, groupId: `sandcor_${times[i - 1]}`, priority: 1 });
            }
          }
        }
      }
    }

    s3h.add(t, m, w);
    s6h.add(t, m, w);
    s12h.add(t, m, w);
    s22h.add(t, m, w);
  }

  const checkCycleWin = (targetIdx: number, creatorTime: number): boolean => {
    const targetT = times[targetIdx];
    const targetMin = minutes[targetIdx];
    const windowRange = withMargin ? 1.5 : 0.5;
    const windowStart = targetT - windowRange * ONE_MIN;
    const windowEnd = targetT + windowRange * ONE_MIN;

    for (let j = targetIdx; j >= 0 && times[j] >= windowStart; j--) {
      if (isWhite[j] && times[j] > creatorTime && Math.abs(minutes[j] - targetMin) <= 1) return true;
    }
    for (let j = targetIdx + 1; j < globalData.length && times[j] <= windowEnd; j++) {
      if (isWhite[j] && times[j] > creatorTime && Math.abs(minutes[j] - targetMin) <= 1) return true;
    }
    return false;
  };

  const signalAllowed = new Set<string>();
  const defaultMicro: WinrateFilterConfig = { enabled: true, minWr: 20, maxWr: 100, hours: 1 };
  const defaultMacro: WinrateFilterConfig = { enabled: true, minWr: 30, maxWr: 100, hours: 72 };
  const activeMicroFilter = microFilter || defaultMicro;
  const activeMacroFilter = macroFilter || defaultMacro;

  for (let sIdx = 0; sIdx < STRAT_NAMES.length; sIdx++) {
    const history2h: { t: number, won: boolean }[] = [];
    const microWindowMs = activeMicroFilter.hours * 3600000;
    const macroWindowMs = activeMacroFilter.hours * 3600000;

    for (let i = 0; i < globalData.length; i++) {
      if (!signalsAtRoll[i].has(sIdx)) continue;
      const t = times[i];
      while (history2h.length > 0 && t - history2h[0].t > Math.max(microWindowMs, macroWindowMs, 24 * 3600000)) history2h.shift();
      const cTime = creatorAtRoll[i].get(sIdx) || 0;

      const microItems = history2h.filter(h => t - h.t <= microWindowMs);
      const microWr = microItems.length > 0 ? (microItems.filter(h => h.won).length / microItems.length) * 100 : 0;

      const macroItems = history2h.filter(h => t - h.t <= macroWindowMs);
      const macroWr = macroItems.length > 0 ? (macroItems.filter(h => h.won).length / macroItems.length) * 100 : 0;

      let passMicro = true;
      if (activeMicroFilter.enabled) passMicro = microWr >= activeMicroFilter.minWr && microWr <= activeMicroFilter.maxWr;
      let passMacro = true;
      if (activeMacroFilter.enabled) passMacro = macroWr >= activeMacroFilter.minWr && macroWr <= activeMacroFilter.maxWr;

      let allowed = passMicro && passMacro;
      if (allowed) signalAllowed.add(`${i}_${sIdx}`);
      const won = checkCycleWin(i, cTime);
      history2h.push({ t, won });
    }
  }

  const finalScoresResult = Array(60).fill(0);
  const finalStratsResult = Array(60).fill(null).map(() => [] as number[]);
  const latestHourKey = Math.floor(latestTime / 3600000);
  const latestMinuteAbsolute = Math.floor(latestTime / 60000);
  const latestM = latestMinuteAbsolute % 60;

  for (const useFilter of [false, true]) {
    const rawScores = Array(60).fill(0);
    const rawStrats = Array(60).fill(null).map(() => new Set<number>());
    const isLatestWhite = isWhite[globalData.length - 1];

    for (let m = 0; m < 60; m++) {
      const row = Math.floor(m / 10);
      const col = m % 10;
      const hkToUse = (m === latestM && isLatestWhite) ? latestHourKey : latestHourKey;

      if (!localDisabledStrats.has(0) && s3h.getRowPct(row, hkToUse) >= 66 && s3h.getColPct(col, hkToUse) >= 66) { rawScores[m]++; rawStrats[m].add(0); }
      if (!localDisabledStrats.has(1) && s6h.getMinutePct(m, hkToUse) >= 50) { rawScores[m]++; rawStrats[m].add(1); }
      if (!localDisabledStrats.has(2) && s12h.getMinutePct(m, hkToUse) >= 35) { rawScores[m]++; rawStrats[m].add(2); }
      if (!localDisabledStrats.has(3) && s22h.getMinutePct(m, hkToUse) >= 22) { rawScores[m]++; rawStrats[m].add(3); }
      if (!localDisabledStrats.has(9)) {
        let hasData = false, hasWhite = false;
        for (const [hk, hadW] of s12h.minuteHours[m]) {
          if (hk > hkToUse - 12 && hk <= hkToUse) {
            hasData = true;
            if (hadW) hasWhite = true;
          }
        }
        if (hasData && !hasWhite) { rawScores[m]++; rawStrats[m].add(9); }
      }
    }

    for (const pt of pendingTargets) {
      if (pt.creatorTime >= latestTime || pt.targetTime <= latestTime + 30000) continue;
      let isAllowed = !localDisabledStrats.has(pt.stratIdx);
      if (isAllowed) {
        const targetMin = new Date(pt.targetTime).getMinutes();
        if (targetMin >= 0 && targetMin <= 59) {
          rawScores[targetMin]++;
          rawStrats[targetMin].add(pt.stratIdx);
        }
      }
    }

    for (let m = 0; m < 60; m++) {
      let finalScore = rawScores[m];
      let finalStrats = new Set(rawStrats[m]);

      if (minutoFilter?.enabled) {
        const mWr = s12h.getMinutePct(m, latestHourKey, minutoFilter.hours);
        if (mWr < minutoFilter.minWr || mWr > minutoFilter.maxWr) {
          finalScore = 0;
          finalStrats = new Set();
        }
      }

      if (useFilter === smartFilter) {
        finalScoresResult[m] = finalScore;
        finalStratsResult[m] = Array.from(finalStrats);
      }
    }
  }

  for (let m = 0; m < 60; m++) {
    scores[m] = finalScoresResult[m];
    activeStratsByMin[m] = finalStratsResult[m];
  }

  const filteredSignalsAtRoll = Array(globalData.length).fill(null).map(() => new Set<number>());
  for (let i = 0; i < globalData.length; i++) {
    for (const sIdx of signalsAtRoll[i]) {
      if (signalAllowed.has(`${i}_${sIdx}`)) filteredSignalsAtRoll[i].add(sIdx);
    }
  }

  const stratStats: StratStat[] = STRAT_NAMES.map(name => ({
    name, winRate: 0, wins: 0, total: 0, sa: 0, sm: 0
  }));

  for (let sIdx = 0; sIdx < STRAT_NAMES.length; sIdx++) {
    let currentSa = 0, maxSa = 0, wins = 0, total = 0;
    for (let i = 0; i < globalData.length; i++) {
      if (times[i] < backtestCutoff || !filteredSignalsAtRoll[i].has(sIdx)) continue;
      const cTime = creatorAtRoll[i].get(sIdx) || 0;
      const won = checkCycleWin(i, cTime);
      total++;
      if (won) { wins++; currentSa = 0; }
      else { currentSa++; if (currentSa > maxSa) maxSa = currentSa; }
    }
    stratStats[sIdx].wins = wins;
    stratStats[sIdx].total = total;
    stratStats[sIdx].winRate = total > 0 ? (wins / total) * 100 : 0;
    stratStats[sIdx].sa = currentSa;
    stratStats[sIdx].sm = maxSa;
  }

  const stats: IaSignalStats[] = [];
  for (let confLvl = 1; confLvl <= 8; confLvl++) {
    let currentSa = 0, maxSa = 0, wins = 0, total = 0;
    for (let i = 0; i < globalData.length; i++) {
      if (times[i] < backtestCutoff) continue;
      const validStrats = Array.from(filteredSignalsAtRoll[i]).filter(sIdx => !localDisabledStrats.has(sIdx));
      if (validStrats.length < confLvl) continue;

      if (minutoFilter?.enabled) {
        const m = minutes[i];
        const hk = Math.floor(times[i] / 3600000);
        const minutoWr = s12h.getMinutePct(m, hk, minutoFilter.hours);
        if (minutoWr < minutoFilter.minWr || minutoWr > minutoFilter.maxWr) continue;
      }

      let maxCreator = 0;
      for (const ct of creatorAtRoll[i].values()) { if (ct > maxCreator) maxCreator = ct; }
      const won = checkCycleWin(i, maxCreator);
      total++;
      if (won) { wins++; currentSa = 0; }
      else { currentSa++; if (currentSa > maxSa) maxSa = currentSa; }
    }

    stats.push({
      conf: confLvl,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      wins, total, sa: currentSa, sm: maxSa
    });
  }

  return {
    scores,
    activeStratsByMin,
    disabledStrats: localDisabledStrats,
    activeStrats: STRAT_NAMES,
    stratStats,
    stats,
    currentHourTracker12h: s12h
  };
}
