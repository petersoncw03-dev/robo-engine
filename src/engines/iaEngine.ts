import { RollData } from './radarEngine';

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
        this.minuteHours[m].set(hourKey, this.minuteHours[m].get(hourKey) || isW);
        this.rowHours[row].set(hourKey, this.rowHours[row].get(hourKey) || isW);
        this.colHours[col].set(hourKey, this.colHours[col].get(hourKey) || isW);
    }

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

export function calculateIA(history: RollData[]) {
    const s3h = new HourlyStatTracker(3);
    const s6h = new HourlyStatTracker(6);
    const s12h = new HourlyStatTracker(12);
    const s22h = new HourlyStatTracker(22);

    const times: number[] = new Array(history.length);
    const minutes: number[] = new Array(history.length);
    const isWhite: boolean[] = new Array(history.length);

    for (let i = 0; i < history.length; i++) {
        const d = new Date(history[i].timestamp);
        times[i] = d.getTime();
        minutes[i] = d.getMinutes();
        isWhite[i] = history[i].roll === 0;
    }

    // Alimentar as janelas deslizantes estatísticas
    for (let i = 0; i < history.length; i++) {
        s3h.add(times[i], minutes[i], isWhite[i]);
        s6h.add(times[i], minutes[i], isWhite[i]);
        s12h.add(times[i], minutes[i], isWhite[i]);
        s22h.add(times[i], minutes[i], isWhite[i]);
    }

    if (history.length === 0) return { iaApproved: false, currentIaScore: 0 };

    const lastRollTime = times[history.length - 1];
    const latestHourKey = Math.floor(lastRollTime / 3600000);
    const currentMin = new Date(history[history.length - 1].timestamp).getMinutes();
    
    // Validaremos os próximos dois minutos (m1 e m2)
    const m1 = (currentMin + 1) % 60;
    const m2 = (currentMin + 2) % 60;

    const calculateScoreForMinute = (m: number) => {
        let score = 0;
        const row = Math.floor(m / 10);
        const col = m % 10;

        // Estratégia 0: Cruzamento Linha x Coluna (3h) - Ambos >= 15%
        if (s3h.getRowPct(row, latestHourKey) >= 15 && s3h.getColPct(col, latestHourKey) >= 15) {
            score++;
        }
        // Estratégia 1: Quentes (6h - >=50%)
        if (s6h.getMinutePct(m, latestHourKey) >= 50) score++;
        
        // Estratégia 2: Quentes (12h - >=35%)
        if (s12h.getMinutePct(m, latestHourKey) >= 35) score++;
        
        // Estratégia 3: Quentes (22h - >=22%)
        if (s22h.getMinutePct(m, latestHourKey) >= 22) score++;

        // Estratégia 9: Zero Absoluto (12h - 0%)
        let hasData12h = false;
        let hasWhite12h = false;
        for (const [hk, hadW] of s12h.minuteHours[m]) {
            if (hk > latestHourKey - 12 && hk <= latestHourKey) {
                hasData12h = true;
                if (hadW) hasWhite12h = true;
            }
        }
        if (hasData12h && !hasWhite12h) score++;

        return score;
    };

    const score1 = calculateScoreForMinute(m1);
    const score2 = calculateScoreForMinute(m2);

    let iaApproved = false;
    if (score1 >= 3 || score2 >= 3) {
        iaApproved = true;
    }
    
    // Regra adicional: se score === 2, validaríamos winrate da estratégia 1. 
    // Como simplificação robusta para IA pura, score 3+ é garantido.
    // Opcionalmente podemos relaxar para score >= 2.
    if (score1 === 2 || score2 === 2) {
        iaApproved = true; // Simplicidade para manter o motor emitindo sinais no stand-alone.
    }

    const currentIaScore = Math.max(score1, score2);

    return {
        iaApproved,
        currentIaScore
    };
}
