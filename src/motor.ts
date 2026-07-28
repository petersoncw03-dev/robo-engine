import { Client } from 'pg';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { calculateIA, RollData } from './engines/iaEngine';

dotenv.config();

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
const announcedSignals = new Set<string>(); // Evita duplicar alerta do mesmo minuto/hora

interface ActiveSignal {
  id: string;
  targetMin: number;
  minPrev: number;
  minNext: number;
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
        `📈 <b>Assertividade:</b> ${wr}%`
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
  for (const sig of activeSignals) {
    if (sig.status !== 'pending') continue;

    // Verificar se o roll atual pertence à janela {M-1, M, M+1} do sinal
    const diffMin = Math.abs(rollMin - sig.targetMin);
    const inWindow = diffMin <= 1 || diffMin >= 59; // Wraparound minuto 0/59

    if (inWindow && isWhite) {
      sig.status = 'win';
      placarDiario.wins++;
      const targetMinStr = String(sig.targetMin).padStart(2, '0');
      await sendTelegramMessage(
        `✅ <b>GREEN NO BRANCO! ⚪ (14X)</b>\n` +
        `🎯 Minuto Alvo: :${targetMinStr}`
      );
      console.log(`[GREEN] Sinal no minuto :${targetMinStr} acertou Branco!`);
      continue;
    }

    // Se passou do tempo máximo da janela (+2min do minuto alvo), expira como LOSS
    if (rollTime > (sig.announcedTime + 4 * 60_000) && !inWindow) {
      if (sig.status === 'pending') {
        sig.status = 'loss';
        placarDiario.losses++;
        const targetMinStr = String(sig.targetMin).padStart(2, '0');
        await sendTelegramMessage(
          `❌ <b>LOSS</b>\n` +
          `🎯 Minuto Alvo: :${targetMinStr}`
        );
        console.log(`[LOSS] Sinal no minuto :${targetMinStr} encerrou sem Branco.`);
      }
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

    // Verifica se atinge a confluência mínima (ex: 3+)
    if (score >= CONFIG.MIN_CONFLUENCIA) {
      const signalKey = `${currentHourKey}_${targetMin}`;

      if (!announcedSignals.has(signalKey)) {
        announcedSignals.add(signalKey);

        const targetMinStr = String(targetMin).padStart(2, '0');
        const minPrevStr = String((targetMin - 1 + 60) % 60).padStart(2, '0');
        const minNextStr = String((targetMin + 1) % 60).padStart(2, '0');

        // Taxa do Placar de Confluência (3h) para o score atual
        const confStat = iaResult.stats.find(s => s.conf === score);
        const confWinrate = confStat ? confStat.winRate : (iaResult.stats.find(s => s.conf === CONFIG.MIN_CONFLUENCIA)?.winRate || 0);

        // Taxa Histórica do Minuto (:MM) nas últimas 3h com margem ±1min
        const minutoWinrate = iaResult.currentHourTracker12h.getMinutePct(targetMin, currentHourKey, CONFIG.MINUTO_FILTER.hours, true);

        // FORMATO DO ALERTA TELEGRAM EXATAMENTE COMO SOLICITADO
        const alertText = 
          `🎯 <b>SINAL CONFIRMADO — MINUTOS DA IA</b>\n\n` +
          `⏰ <b>Minuto Alvo:</b> :${targetMinStr} <i>(Entrar no :${minPrevStr}, :${targetMinStr} e :${minNextStr})</i>\n` +
          `🔥 <b>Confluência:</b> ${score} Estratégias\n` +
          `📊 <b>Assertividade da confluência:</b> ${confWinrate.toFixed(1)}%\n` +
          `🕑 <b>Assertividade do minuto:</b> ${minutoWinrate.toFixed(1)}%`;

        await sendTelegramMessage(alertText);
        console.log(`[ALERTA ENVIADO] Minuto :${targetMinStr} | Conf: ${score} | MinWr: ${minutoWinrate.toFixed(1)}%`);

        activeSignals.push({
          id: signalKey,
          targetMin,
          minPrev: (targetMin - 1 + 60) % 60,
          minNext: (targetMin + 1) % 60,
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
    console.log('📥 Carregando histórico inicial do PostgreSQL (240h / 10 dias)...');
    const res = await pgClient.query(`
      SELECT id, roll, color, created_at as timestamp 
      FROM results 
      WHERE created_at >= NOW() - INTERVAL '240 hours'
      ORDER BY created_at ASC
    `);

    if (res.rows && res.rows.length > 0) {
      for (const row of res.rows) {
        history.push({
          id: String(row.id),
          roll: Number(row.roll),
          color: String(row.color || ''),
          timestamp: row.timestamp
        });
      }
      console.log(`✅ ${history.length} rodadas carregadas no histórico inicial.`);
    }

    // Escutar rodadas em tempo real via LISTEN / NOTIFY ou Polling de segurança
    await pgClient.query('LISTEN new_roll');
    pgClient.on('notification', async (msg) => {
      if (msg.payload) {
        try {
          const newRoll = JSON.parse(msg.payload);
          await processNewRoll({
            id: String(newRoll.id || Date.now()),
            roll: Number(newRoll.roll),
            color: String(newRoll.color || ''),
            timestamp: newRoll.created_at || newRoll.timestamp || new Date().toISOString()
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
        const pollRes = await pgClient.query(`
          SELECT id, roll, color, created_at as timestamp 
          FROM results 
          ORDER BY created_at DESC 
          LIMIT 1
        `);

        if (pollRes.rows && pollRes.rows.length > 0) {
          const latest = pollRes.rows[0];
          const latestId = String(latest.id);
          if (latestId !== lastProcessedId) {
            lastProcessedId = latestId;
            await processNewRoll({
              id: latestId,
              roll: Number(latest.roll),
              color: String(latest.color || ''),
              timestamp: latest.timestamp
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
