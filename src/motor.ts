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
  MIN_CONFLUENCIA: Number(process.env.MIN_CONFLUENCIA || 1), // 1 = Todas as confluências (1+)
  MICRO_FILTER: { enabled: true, minWr: 20, maxWr: 100, hours: 1 }, // 1h, 20% a 100%
  MACRO_FILTER: { enabled: true, minWr: 30, maxWr: 100, hours: 72 }, // 72h, 30% a 100%
  MINUTO_FILTER: { enabled: true, minWr: 40, maxWr: 100, hours: 3 }, // 3h, 40% a 100%
  DISABLED_STRATS: new Set<number>([4, 5, 6, 8, 9, 10, 11, 12]), // 7 Elite ativas por padrão
  PERIOD_HOURS: 3, // Período do Backtest para o Placar de Confluência
  LOOKAHEAD_MINUTES: 10, // Analisar alvos para os próximos 10 minutos
};

async function sendTelegramMessage(text: string) {
  if (bot && TELEGRAM_CHAT_ID) {
    try {
      await bot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Erro ao enviar mensagem para o Telegram:', error);
    }
  } else {
    console.log('\n[TELEGRAM MOCK]\n' + text.replace(/<[^>]*>?/gm, '') + '\n');
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

interface ActiveSignal {
  id: string;
  targetMin: number;
  minPrev: number;
  minNext: number;
  targetTime: number;
  announcedTime: number;
  targetHourKey: number;
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

  // Helper: verifica se o minuto atual já passou da janela do sinal ({M-1, M, M+1})
  const isMinutePastWindow = (rMin: number, tMin: number, nMin: number, rTime: number, tTime: number): boolean => {
    if (rTime > tTime + 2.5 * 60_000) return true; // Segurança por tempo absoluto
    if (nMin === 0) return rMin > 0 && rMin < (tMin - 1 + 60) % 60;
    if (nMin === 1) return rMin > 1 && rMin < (tMin - 1 + 60) % 60;
    return rMin > nMin;
  };

  // 1. Acompanhar e Resolver Sinais Ativos Pendentes
  for (const sig of activeSignals) {
    if (sig.status !== 'pending') continue;

    const allowedMinutes = [sig.minPrev, sig.targetMin, sig.minNext];

    // Se o roll caiu exatamente nos minutos autorizados (:17, :18, :19)
    if (allowedMinutes.includes(rollMin)) {
      if (isWhite) {
        sig.status = 'win';
        placarDiario.wins++;
        const targetMinStr = String(sig.targetMin).padStart(2, '0');
        const rollMinStr = String(rollMin).padStart(2, '0');
        await sendTelegramMessage(
          `✅ <b>GREEN NO BRANCO! ⚪ (14X)</b>\n` +
          `🎯 Minuto Alvo: :${targetMinStr}\n\n` +
          `🤖 <i>Apex Machine</i>`
        );
        console.log(`[GREEN] Sinal no minuto :${targetMinStr} acertou Branco no minuto :${rollMinStr}!`);
        continue;
      }
    }

    // Se o relógio já passou por completo do minuto final (ex: virou :20) -> LOSS!
    if (isMinutePastWindow(rollMin, sig.targetMin, sig.minNext, rollTime, sig.targetTime)) {
      sig.status = 'loss';
      placarDiario.losses++;
      const targetMinStr = String(sig.targetMin).padStart(2, '0');
      await sendTelegramMessage(
        `❌ <b>LOSS</b>\n` +
        `🎯 Minuto Alvo: :${targetMinStr}\n\n` +
        `🤖 <i>Apex Machine</i>`
      );
      console.log(`[LOSS] Sinal no minuto :${targetMinStr} encerrou sem Branco.`);
    }
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

  // Analisar alvos para os próximos minutos
  for (let offset = 1; offset <= CONFIG.LOOKAHEAD_MINUTES; offset++) {
    const targetTime = rollTime + offset * 60_000;
    const targetMin = new Date(targetTime).getMinutes();
    const score = iaResult.scores[targetMin];

    // Verifica se atinge a confluência mínima
    if (score >= CONFIG.MIN_CONFLUENCIA) {
      const signalKey = `${currentHourKey}_${targetMin}`;
      const targetMinStr = String(targetMin).padStart(2, '0');
      const minPrevStr = String((targetMin - 1 + 60) % 60).padStart(2, '0');
      const minNextStr = String((targetMin + 1) % 60).padStart(2, '0');

      // FASE 1: Pré-Alerta de Atenção (Faltando 3 a 7 minutos)
      if (offset >= 3 && offset <= 7 && !announcedPreAlerts.has(signalKey)) {
        announcedPreAlerts.add(signalKey);
        const preAlertText =
          `👀 <b>ATENÇÃO — OPORTUNIDADE EM DETECÇÃO</b>\n\n` +
          `⚡ <b>A IA identificou um padrão se formando para os próximos minutos!</b>\n` +
          `⏰ <b>Minuto Alvo Previsto:</b> :${targetMinStr} <i>(Janela :${minPrevStr}, :${targetMinStr} e :${minNextStr})</i>\n` +
          `🔥 <b>Confluência Atual:</b> ${score} Estratégias\n\n` +
          `⏳ <i>Aguarde a confirmação final faltando 2 minutos...</i>\n\n` +
          `🤖 <i>Apex Machine</i>`;

        await sendTelegramMessage(preAlertText);
        console.log(`[PRÉ-ALERTA ENVIADO] Minuto :${targetMinStr} | Offset: ${offset}m`);
      }

      // FASE 2: Sinal Oficial Confirmado (Faltando 2 minutos ou menos)
      if (offset <= 2 && !announcedConfirmedSignals.has(signalKey)) {
        announcedConfirmedSignals.add(signalKey);

        // Taxa do Placar de Confluência (3h) para o score atual
        const confStat = iaResult.stats.find(s => s.conf === score);
        const confWinrate = confStat ? confStat.winRate : (iaResult.stats.find(s => s.conf === CONFIG.MIN_CONFLUENCIA)?.winRate || 0);

        // Taxa Histórica do Minuto (:MM) nas últimas 3h com margem ±1min
        const minutoWinrate = iaResult.currentHourTracker12h.getMinutePct(targetMin, currentHourKey, CONFIG.MINUTO_FILTER.hours, true);

        // FORMATO DO SINAL CONFIRMADO COM ASSINATURA APEX MACHINE
        const alertText = 
          `🎯 <b>SINAL CONFIRMADO — MINUTOS DA IA</b>\n\n` +
          `⏰ <b>Minuto Alvo:</b> :${targetMinStr} <i>(Entrar no :${minPrevStr}, :${targetMinStr} e :${minNextStr})</i>\n` +
          `🔥 <b>Confluência:</b> ${score} Estratégias\n` +
          `📊 <b>Assertividade da confluência:</b> ${confWinrate.toFixed(1)}%\n` +
          `🕑 <b>Assertividade do minuto:</b> ${minutoWinrate.toFixed(1)}%\n\n` +
          `🤖 <i>Apex Machine</i>`;

        await sendTelegramMessage(alertText);
        console.log(`[SINAL CONFIRMADO ENVIADO] Minuto :${targetMinStr} | Conf: ${score} | MinWr: ${minutoWinrate.toFixed(1)}%`);

        activeSignals.push({
          id: signalKey,
          targetMin,
          minPrev: (targetMin - 1 + 60) % 60,
          minNext: (targetMin + 1) % 60,
          targetTime,
          announcedTime: rollTime,
          targetHourKey: currentHourKey,
          score,
          status: 'pending'
        });
      }
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
