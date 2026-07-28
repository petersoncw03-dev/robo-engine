import http from 'http';
import { Client } from 'pg';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { calculateIA, RollData } from './engines/iaEngine';

dotenv.config();

// Servidor de Health Check para o EasyPanel (Impede o SIGTERM)
const PORT = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('RoboBlaze Engine Running OK\n');
}).listen(PORT, () => {
  console.log(`🌐 [ROBO ENGINE] Servidor de Health Check rodando na porta ${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('❌ [ROBO ENGINE] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ [ROBO ENGINE] Unhandled Rejection:', reason);
});

// ============================================================================
// CONFIGURAÇÕES DO TELEGRAM E FILTROS DO ROBÔ
// ============================================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const bot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN, { polling: false }) : null;

// Configuração Operacional dos Filtros da IA (Conforme Especificação)
const CONFIG = {
  MIN_CONFLUENCIA: Number(process.env.MIN_CONFLUENCIA || 2), // 2 = Filtro padrão de confluência para alta assertividade
  MICRO_FILTER: { enabled: true, minWr: 20, maxWr: 100, hours: 1 }, // 1h, 20% a 100%
  MACRO_FILTER: { enabled: true, minWr: 30, maxWr: 100, hours: 72 }, // 72h, 30% a 100%
  MINUTO_FILTER: { enabled: true, minWr: 40, maxWr: 100, hours: 3 }, // 3h, 40% a 100%
  DISABLED_STRATS: new Set<number>([4, 5, 6, 8, 9, 10, 11, 12]), // 7 Elite ativas por padrão
  PERIOD_HOURS: 3, // Período do Backtest para o Placar de Confluência
  LOOKAHEAD_MINUTES: 10, // Analisar alvos para os próximos 10 minutos
};

async function sendTelegramMessage(text: string, retries = 3) {
  if (!bot || !TELEGRAM_CHAT_ID) {
    console.log('\n[TELEGRAM MOCK]\n' + text.replace(/<[^>]*>?/gm, '') + '\n');
    return;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await bot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' });
      return;
    } catch (error: any) {
      const msg = error?.message || String(error);
      if (attempt < retries) {
        console.warn(`⚠️ [TELEGRAM] Instabilidade na rede (${msg}). Tentativa ${attempt}/${retries}... Reenviando em 1.5s`);
        await new Promise(res => setTimeout(res, 1500));
      } else {
        console.error(`❌ [TELEGRAM] Falha ao enviar mensagem após ${retries} tentativas:`, msg);
      }
    }
  }
}

// ============================================================================
// BANCO DE DADOS POSTGRESQL
// ============================================================================
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/blaze';

const isSslDisabled = DATABASE_URL.includes('sslmode=disable');
const pgClient = new Client({
  connectionString: DATABASE_URL,
  ssl: isSslDisabled ? false : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false)
});

// ============================================================================
// MEMÓRIA E ESTADO DO ROBÔ
// ============================================================================
const history: RollData[] = [];
const announcedPreAlerts = new Set<string>();
const announcedConfirmedSignals = new Set<string>();
const announcedTargetMinutes = new Set<string>(); // Evita re-anunciar o mesmo minuto alvo várias vezes com subconjuntos
const cancelledPreAlerts = new Set<string>();

interface PendingPreAlert {
  signalKey: string;
  targetMins: number[];
  displayMinStr: string;
  windowStr: string;
  minPrev: number;
  minNext: number;
  allowedMinutes: number[];
  targetTime: number;
  maxTargetTime: number;
}

const pendingPreAlerts = new Map<string, PendingPreAlert>();

interface ActiveSignal {
  id: string;
  targetMins: number[];
  displayMinStr: string;
  windowStr: string;
  minPrev: number;
  minNext: number;
  allowedMinutes: number[];
  targetTime: number;
  endTime: number; // Epoch timestamp onde a janela termina e o LOSS deve ser declarado se nenhum branco caiu
  score: number;
  status: 'pending' | 'win' | 'loss';
}

const activeSignals: ActiveSignal[] = [];

let placarDiario = {
  wins: 0,
  losses: 0,
  lastResetDate: new Date().getDate()
};

function checkMidnightReset() {
  const today = new Date().getDate();
  if (placarDiario.lastResetDate !== today) {
    if (placarDiario.wins > 0 || placarDiario.losses > 0) {
      const total = placarDiario.wins + placarDiario.losses;
      const wr = total > 0 ? ((placarDiario.wins / total) * 100).toFixed(1) : '0.0';
      sendTelegramMessage(
        `🌙 <b>Resumo do Dia — Minutos da IA</b>\n\n` +
        `✅ <b>Vitórias (Brancos):</b> ${placarDiario.wins}\n` +
        `❌ <b>Derrotas:</b> ${placarDiario.losses}\n` +
        `📈 <b>Assertividade:</b> ${wr}%\n\n` +
        `🤖 <i>Apex Machine</i>`
      );
    }
    placarDiario.wins = 0;
    placarDiario.losses = 0;
    placarDiario.lastResetDate = today;
    console.log('🔄 Placar diário do Telegram resetado.');
  }
}

// ============================================================================
// PROCESSAMENTO PRINCIPAL DE RODADAS EM TEMPO REAL
// ============================================================================
async function processNewRoll(roll: RollData) {
  history.push(roll);
  if (history.length > 3000) history.shift(); // Mantém memória leve

  checkMidnightReset();

  const rollTime = new Date(roll.timestamp).getTime();
  const rollMin = new Date(roll.timestamp).getMinutes();
  const isWhite = Number(roll.roll) === 0;

  // 1. Acompanhar e Resolver Sinais Ativos Pendentes
  const winningSignals: ActiveSignal[] = [];

  for (const sig of activeSignals) {
    if (sig.status !== 'pending') continue;

    // Se o roll caiu exatamente nos minutos autorizados da janela unificada
    if (sig.allowedMinutes.includes(rollMin)) {
      if (isWhite) {
        sig.status = 'win';
        placarDiario.wins++;
        winningSignals.push(sig);
        continue;
      }
    }

    // Se o tempo da pedra passou por completo do encerramento da janela (sig.endTime) -> LOSS!
    if (rollTime >= sig.endTime) {
      sig.status = 'loss';
      placarDiario.losses++;
      await sendTelegramMessage(
        `❌ <b>LOSS</b>\n` +
        `🎯 Minuto Alvo: ${sig.displayMinStr}\n\n` +
        `🤖 <i>Apex Machine</i>`
      );
      console.log(`[LOSS] Sinal ${sig.displayMinStr} encerrou sem Branco.`);
    }
  }

  // Se 1 ou mais sinais ganharam no Branco nesta rodada, envia UMA ÚNICA mensagem consolidada de GREEN
  if (winningSignals.length > 0) {
    const displayStr = winningSignals.map(s => s.displayMinStr).join(' / ');
    await sendTelegramMessage(
      `✅ <b>GREEN NO BRANCO! ⚪ (14X)</b>\n` +
      `🎯 Minuto Alvo: ${displayStr}\n\n` +
      `🤖 <i>Apex Machine</i>`
    );
    console.log(`[GREEN] Sinais ${displayStr} acertaram Branco no minuto :${String(rollMin).padStart(2, '0')}!`);
  }

  // 2. Executar Motor da IA para Identificar Novos Sinais
  if (history.length < 50) return;

  const iaResult = calculateIA(
    history,
    CONFIG.PERIOD_HOURS,
    CONFIG.DISABLED_STRATS,
    true, // withMargin
    false, // smartFilter
    CONFIG.MICRO_FILTER,
    CONFIG.MACRO_FILTER,
    CONFIG.MINUTO_FILTER
  );

  const currentHourKey = Math.floor(rollTime / 3600000);

  // 3. Resolver Pré-Alertas Pendentes (Confirmar ou Cancelar)
  for (const [key, pa] of Array.from(pendingPreAlerts.entries())) {
    if (announcedConfirmedSignals.has(key) || cancelledPreAlerts.has(key)) {
      pendingPreAlerts.delete(key);
      continue;
    }

    // Faltando 2.5 minutos ou menos para o início da janela de entrada
    const isTimeToConfirm = (pa.targetTime - 60_000 - rollTime) <= 2.5 * 60_000 || rollMin === pa.minPrev;

    if (isTimeToConfirm) {
      const currentMaxScore = Math.max(...pa.targetMins.map(m => iaResult.scores[m]));

      if (currentMaxScore >= CONFIG.MIN_CONFLUENCIA && !pa.allowedMinutes.includes(rollMin)) {
        // CONFIRMAR SINAL
        announcedConfirmedSignals.add(key);
        pendingPreAlerts.delete(key);

        for (const m of pa.targetMins) {
          const tHk = Math.floor(pa.targetTime / 3600000);
          announcedTargetMinutes.add(`${tHk}_${m}`);
        }

        const confStat = iaResult.stats.find(s => s.conf === currentMaxScore);
        const confWinrate = confStat ? confStat.winRate : (iaResult.stats.find(s => s.conf === CONFIG.MIN_CONFLUENCIA)?.winRate || 0);
        const minutoWinrate6h = iaResult.currentHourTracker12h.getMinutePct(pa.targetMins[0], currentHourKey, 6, true);

        const alertText =
          `🎯 <b>SINAL CONFIRMADO — MINUTOS DA IA</b>\n\n` +
          `⏰ <b>Minuto Alvo:</b> ${pa.displayMinStr} <i>(${pa.windowStr})</i>\n` +
          `🔥 <b>Confluência:</b> ${currentMaxScore} Estratégias\n` +
          `📊 <b>Assertividade da confluência:</b> ${confWinrate.toFixed(1)}%\n` +
          `🕑 <b>Assertividade do minuto em 6h:</b> ${minutoWinrate6h.toFixed(1)}%\n\n` +
          `🤖 <i>Apex Machine</i>`;

        await sendTelegramMessage(alertText);
        console.log(`[SINAL CONFIRMADO ENVIADO] Minutos ${pa.displayMinStr} | Conf: ${currentMaxScore}`);

        activeSignals.push({
          id: key,
          targetMins: pa.targetMins,
          displayMinStr: pa.displayMinStr,
          windowStr: pa.windowStr,
          minPrev: pa.minPrev,
          minNext: pa.minNext,
          allowedMinutes: pa.allowedMinutes,
          targetTime: pa.targetTime,
          endTime: pa.maxTargetTime + 2 * 60_000,
          score: currentMaxScore,
          status: 'pending'
        });
      } else {
        // CANCELAR OPORTUNIDADE (A confluência caiu ou o tempo esgotou antes de confirmar)
        cancelledPreAlerts.add(key);
        pendingPreAlerts.delete(key);

        const cancelText =
          `⚠️ <b>OPORTUNIDADE CANCELADA</b>\n\n` +
          `📉 <b>Minuto Alvo Previsto:</b> ${pa.displayMinStr}\n` +
          `ℹ️ <i>A confluência oscilou antes da entrada. Entrada ABORTADA por segurança!</i>\n\n` +
          `🤖 <i>Apex Machine</i>`;

        await sendTelegramMessage(cancelText);
        console.log(`[OPORTUNIDADE CANCELADA ENVIADA] Minutos ${pa.displayMinStr}`);
      }
    }
  }

  // 4. Analisar alvos para os próximos minutos e Agrupar Minutos Consecutivos
  interface EligibleMinute {
    targetMin: number;
    targetTime: number;
    score: number;
    offset: number;
  }

  const eligibleMinutes: EligibleMinute[] = [];

  for (let offset = 1; offset <= CONFIG.LOOKAHEAD_MINUTES; offset++) {
    const targetTime = rollTime + offset * 60_000;
    const targetMin = new Date(targetTime).getMinutes();
    const targetHourKey = Math.floor(targetTime / 3600000);
    const score = iaResult.scores[targetMin];

    // Trava de Deduplicação: se este minuto já foi anunciado em qualquer sinal prévio deste ciclo, ignora
    if (announcedTargetMinutes.has(`${targetHourKey}_${targetMin}`)) continue;

    const windowStartMin = (targetMin - 1 + 60) % 60;
    const isAlreadyInOrPastWindow = rollMin === windowStartMin || rollMin === targetMin || rollMin === (targetMin + 1) % 60;
    if (isAlreadyInOrPastWindow) continue;

    if (score >= CONFIG.MIN_CONFLUENCIA) {
      const minWr = iaResult.currentHourTracker12h.getMinutePct(targetMin, currentHourKey, CONFIG.MINUTO_FILTER.hours, true);
      if (minWr >= CONFIG.MINUTO_FILTER.minWr) {
        eligibleMinutes.push({ targetMin, targetTime, score, offset });
      }
    }
  }

  // Agrupar minutos consecutivos em Clusters (ex: [59, 0] ou [1, 2, 3])
  const clusters: EligibleMinute[][] = [];
  if (eligibleMinutes.length > 0) {
    let currentCluster: EligibleMinute[] = [eligibleMinutes[0]];

    for (let i = 1; i < eligibleMinutes.length; i++) {
      const prev = currentCluster[currentCluster.length - 1];
      const curr = eligibleMinutes[i];

      const isConsecutive = (curr.targetMin === (prev.targetMin + 1) % 60) && ((curr.targetTime - prev.targetTime) <= 90_000);

      if (isConsecutive) {
        currentCluster.push(curr);
      } else {
        clusters.push(currentCluster);
        currentCluster = [curr];
      }
    }
    clusters.push(currentCluster);
  }

  // Processar cada Cluster
  for (const cluster of clusters) {
    const mins = cluster.map(item => item.targetMin);
    const firstMin = mins[0];
    const lastMin = mins[mins.length - 1];
    const firstTargetTime = cluster[0].targetTime;
    const lastTargetTime = cluster[cluster.length - 1].targetTime;
    const minPrev = (firstMin - 1 + 60) % 60;
    const minNext = (lastMin + 1) % 60;

    const allowedMinutes: number[] = [];
    let currM = minPrev;
    while (true) {
      allowedMinutes.push(currM);
      if (currM === minNext) break;
      currM = (currM + 1) % 60;
    }

    let displayMinStr = '';
    if (mins.length === 1) {
      displayMinStr = `:${String(firstMin).padStart(2, '0')}`;
    } else if (mins.length === 2) {
      displayMinStr = `:${String(firstMin).padStart(2, '0')} e :${String(lastMin).padStart(2, '0')}`;
    } else {
      displayMinStr = mins.map(m => `:${String(m).padStart(2, '0')}`).join(', ');
    }

    const windowStr = `Entrar do :${String(minPrev).padStart(2, '0')} ao :${String(minNext).padStart(2, '0')}`;
    const maxScore = Math.max(...cluster.map(item => item.score));
    const minOffset = Math.min(...cluster.map(item => item.offset));
    const signalKey = `${currentHourKey}_${mins.join('_')}`;

    // FASE 1: Pré-Alerta de Atenção (Faltando 3 a 7 minutos)
    if (minOffset >= 3 && minOffset <= 7 && !announcedPreAlerts.has(signalKey)) {
      announcedPreAlerts.add(signalKey);
      for (const m of mins) {
        const tHk = Math.floor(firstTargetTime / 3600000);
        announcedTargetMinutes.add(`${tHk}_${m}`);
      }

      pendingPreAlerts.set(signalKey, {
        signalKey,
        targetMins: mins,
        displayMinStr,
        windowStr,
        minPrev,
        minNext,
        allowedMinutes,
        targetTime: firstTargetTime,
        maxTargetTime: lastTargetTime
      });

      const preAlertText =
        `👀 <b>ATENÇÃO — OPORTUNIDADE EM DETECÇÃO</b>\n\n` +
        `⚡ <b>A IA identificou um padrão se formando para os próximos minutos!</b>\n` +
        `⏰ <b>Minutos Alvo:</b> ${displayMinStr} <i>(${windowStr})</i>\n` +
        `🔥 <b>Confluência Atual:</b> ${maxScore} Estratégias\n\n` +
        `⏳ <i>Aguarde a confirmação final faltando 2 minutos...</i>\n\n` +
        `🤖 <i>Apex Machine</i>`;

      await sendTelegramMessage(preAlertText);
      console.log(`[PRÉ-ALERTA ENVIADO] Minutos ${displayMinStr} | Offset: ${minOffset}m`);
    }

    // FASE 2: Sinal Oficial Confirmado Direto (se gerado com 2 min ou menos de antecedência)
    if (minOffset <= 2 && !announcedConfirmedSignals.has(signalKey) && !cancelledPreAlerts.has(signalKey)) {
      announcedConfirmedSignals.add(signalKey);
      for (const m of mins) {
        const tHk = Math.floor(firstTargetTime / 3600000);
        announcedTargetMinutes.add(`${tHk}_${m}`);
      }

      const confStat = iaResult.stats.find(s => s.conf === maxScore);
      const confWinrate = confStat ? confStat.winRate : (iaResult.stats.find(s => s.conf === CONFIG.MIN_CONFLUENCIA)?.winRate || 0);
      const minutoWinrate6h = iaResult.currentHourTracker12h.getMinutePct(firstMin, currentHourKey, 6, true);

      const alertText = 
        `🎯 <b>SINAL CONFIRMADO — MINUTOS DA IA</b>\n\n` +
        `⏰ <b>Minuto Alvo:</b> ${displayMinStr} <i>(${windowStr})</i>\n` +
        `🔥 <b>Confluência:</b> ${maxScore} Estratégias\n` +
        `📊 <b>Assertividade da confluência:</b> ${confWinrate.toFixed(1)}%\n` +
        `🕑 <b>Assertividade do minuto em 6h:</b> ${minutoWinrate6h.toFixed(1)}%\n\n` +
        `🤖 <i>Apex Machine</i>`;

      await sendTelegramMessage(alertText);
      console.log(`[SINAL CONFIRMADO ENVIADO] Minutos ${displayMinStr} | Conf: ${maxScore}`);

      activeSignals.push({
        id: signalKey,
        targetMins: mins,
        displayMinStr,
        windowStr,
        minPrev,
        minNext,
        allowedMinutes,
        targetTime: firstTargetTime,
        endTime: lastTargetTime + 2 * 60_000,
        score: maxScore,
        status: 'pending'
      });
    }
  }
}

// ============================================================================
// CARGA INICIAL DO BANCO DE DADOS & LOOP DE LISTENING
// ============================================================================
async function startEngine() {
  console.log('🚀 Iniciando RoboBlaze Engine — Minutos da IA...');
  
  try {
    await pgClient.connect();
    console.log('✅ Conectado ao PostgreSQL com sucesso.');

    // Carga Inicial: Puxa 240 horas (10 dias) para alimentar o filtro Macro de 72h com Warmup completo
    console.log('📥 [ROBO ENGINE] Carregando histórico inicial do PostgreSQL (240h / 10 dias)...');
    let res;
    try {
      res = await pgClient.query(`
        SELECT id, roll, color, timestamp 
        FROM results 
        WHERE timestamp >= NOW() - INTERVAL '240 hours'
        ORDER BY timestamp ASC
      `);
    } catch (e) {
      res = await pgClient.query(`
        SELECT id, roll, color, timestamp 
        FROM results 
        ORDER BY id ASC
      `);
    }

    if (res.rows && res.rows.length > 0) {
      for (const row of res.rows) {
        history.push({
          id: String(row.id),
          roll: Number(row.roll),
          color: String(row.color || ''),
          timestamp: row.timestamp || new Date().toISOString()
        });
      }
      console.log(`✅ [ROBO ENGINE] ${history.length} rodadas carregadas no histórico inicial.`);
    }

    // Escutar rodadas em tempo real nos dois canais possíveis (nova_pedra e new_roll)
    await pgClient.query('LISTEN nova_pedra');
    await pgClient.query('LISTEN new_roll');
    console.log('📢 [ROBO ENGINE] Escutando canais LISTEN: nova_pedra e new_roll');

    pgClient.on('notification', async (msg) => {
      if (msg.payload) {
        try {
          const newRoll = JSON.parse(msg.payload);
          console.log(`📢 [ROBO ENGINE] Nova pedra via NOTIFY (${msg.channel}):`, newRoll.roll !== undefined ? newRoll.roll : newRoll);
          await processNewRoll({
            id: String(newRoll.id || Date.now()),
            roll: Number(newRoll.roll),
            color: String(newRoll.color || ''),
            timestamp: newRoll.timestamp || newRoll.created_at || new Date().toISOString()
          });
        } catch (e) {
          console.error('Erro ao processar notificação de rodada:', e);
        }
      }
    });

    // Polling de segurança a cada 3 segundos (garante recebimento se LISTEN falhar)
    let lastProcessedId = history.length > 0 ? history[history.length - 1].id : '';

    setInterval(async () => {
      try {
        let pollRes;
        try {
          pollRes = await pgClient.query(`
            SELECT id, roll, color, timestamp 
            FROM results 
            ORDER BY timestamp DESC 
            LIMIT 1
          `);
        } catch (e) {
          pollRes = await pgClient.query(`
            SELECT id, roll, color, timestamp 
            FROM results 
            ORDER BY id DESC 
            LIMIT 1
          `);
        }

        if (pollRes.rows && pollRes.rows.length > 0) {
          const latest = pollRes.rows[0];
          const latestId = String(latest.id);
          if (latestId !== lastProcessedId) {
            lastProcessedId = latestId;
            await processNewRoll({
              id: latestId,
              roll: Number(latest.roll),
              color: String(latest.color || ''),
              timestamp: latest.timestamp || new Date().toISOString()
            });
          }
        }
      } catch (err) {
        console.error('Erro no Polling de rodadas:', err);
      }
    }, 3000);

    console.log('🟢 RoboBlaze Engine rodando e aguardando rodadas...');

  } catch (error) {
    console.error('❌ Erro na inicialização do RoboBlaze Engine:', error);
  }
}

startEngine();
