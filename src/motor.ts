import { Client } from 'pg';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// TELEGRAM
// ============================================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const bot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN, { polling: false }) : null;

const REGRAS_TELEGRAM = {
    // Enviar sinal apenas se Nível de Força for >= 2
    MESTRE_FORCA_MINIMA: 2,
};

async function sendTelegramMessage(text: string) {
    if (bot && TELEGRAM_CHAT_ID) {
        try {
            await bot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('Erro ao enviar mensagem para o Telegram:', error);
        }
    } else {
        console.log('[TELEGRAM MOCK]', text.replace(/<[^>]*>?/gm, ''));
    }
}

// ============================================================================
// ESTADO E MEMÓRIA
// ============================================================================
interface RollData {
    id: string;
    timestamp: string;
    color: string;
    roll: number;
}

interface MestreState {
    status: 'standby' | 'active' | 'win' | 'loss';
    step: number;
    level: number;
    stones: number[];
    // FIX #1: Rastrear se este sinal foi anunciado no Telegram
    wasAnnounced: boolean;
}

// "Sliding Window" - Máximo de 2000 pedras na memória RAM
const MAX_HISTORY = 2000;
const history: RollData[] = [];

let mestreState: MestreState = {
    status: 'standby',
    step: 0,
    level: 0,
    stones: [],
    wasAnnounced: false,
};

let placarDiario = {
    wins: 0,
    losses: 0,
    lastResetDate: new Date().getDate()
};

function checkMidnightReset() {
    const today = new Date().getDate();
    if (placarDiario.lastResetDate !== today) {
        if (placarDiario.wins > 0 || placarDiario.losses > 0) {
            sendTelegramMessage(`🌙 <b>Resumo do Dia - RoboBlaze</b>\n\n✅ Vitórias: ${placarDiario.wins}\n❌ Derrotas: ${placarDiario.losses}`);
        }
        placarDiario.wins = 0;
        placarDiario.losses = 0;
        placarDiario.lastResetDate = today;
        console.log('🔄 Placar diário resetado.');
    }
}

// ============================================================================
// ENGINES
// ============================================================================
import { calculateRadar } from './engines/radarEngine';
import { calculateIA } from './engines/iaEngine';

function processAlgorithms(newRoll: RollData) {
    // Manter a Janela Deslizante
    history.push(newRoll);
    if (history.length > MAX_HISTORY) {
        history.shift();
    }

    if (history.length < 50) return null;

    const isBranco = newRoll.color.toLowerCase().includes('branco') || newRoll.roll === 0;

    const radarData = calculateRadar(history);
    let points = radarData.radarPoints;

    const iaData = calculateIA(history);
    const iaApproved = iaData.iaApproved;

    // Regra de Aprovação: Pelo menos 1 gatilho radar E validado por IA ou Zonas Quentes
    let finalMestreApproved = false;
    if (points >= 1 && (iaApproved || radarData.hasZonasQuentes)) {
        finalMestreApproved = true;
    } else {
        points = 0;
    }

    return {
        levelPoints: finalMestreApproved ? points : 0,
        isBranco,
        engineState: { radarData, iaData }
    };
}

// ============================================================================
// FIX #1: Persistência do estado no banco para sobreviver a restarts
// ============================================================================
async function salvarEstadoNoBanco(pgClient: Client, estadoMotor: object) {
    try {
        await pgClient.query(
            'UPDATE engine_state SET state = $1 WHERE id = 1',
            [JSON.stringify(estadoMotor)]
        );
    } catch (err) {
        console.error('Erro ao salvar estado no banco:', err);
    }
}

async function restaurarEstadoDoBanco(pgClient: Client) {
    try {
        const res = await pgClient.query('SELECT state FROM engine_state WHERE id = 1');
        if (res.rows.length > 0 && res.rows[0].state) {
            const saved = res.rows[0].state;
            if (saved.mestreState && saved.mestreState.status !== 'standby') {
                mestreState = saved.mestreState;
                console.log(`♻️  Estado restaurado: status=${mestreState.status}, step=${mestreState.step}, level=${mestreState.level}, announced=${mestreState.wasAnnounced}`);
            }
            if (saved.placarDiario) {
                placarDiario = saved.placarDiario;
            }
        }
    } catch (err) {
        console.error('Erro ao restaurar estado do banco:', err);
    }
}

// ============================================================================
// FIX #5: Reconexão automática ao banco
// ============================================================================
async function startEngine() {
    while (true) {
        try {
            await runEngine();
        } catch (error) {
            console.error('Motor caiu, reiniciando em 5s...', error);
            await sendTelegramMessage('⚠️ <b>Motor reiniciando</b> — Reconectando ao banco em 5 segundos...');
        }
        await new Promise(res => setTimeout(res, 5000));
    }
}

async function runEngine() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });

    await client.connect();
    console.log('🔥 Robo-Engine conectado ao PostgreSQL!');

    // Criar tabela de estado se não existir
    await client.query('CREATE TABLE IF NOT EXISTS engine_state (id INT PRIMARY KEY, state JSONB)');
    await client.query("INSERT INTO engine_state (id, state) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING");

    // FIX #1: Restaurar estado antes de começar
    await restaurarEstadoDoBanco(client);

    // Warmup
    try {
        console.log('⏳ Buscando últimas 2000 pedras...');
        const res = await client.query('SELECT id, color, roll, timestamp FROM results ORDER BY timestamp DESC LIMIT 2000');
        const rows = res.rows.reverse();
        for (const row of rows) {
            history.push({
                id: row.id,
                timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
                color: row.color,
                roll: parseInt(row.roll)
            });
        }
        console.log(`✅ Warmup: ${history.length} pedras em memória.`);
    } catch (err) {
        console.error('⚠️ Erro no warmup:', err);
    }

    await client.query('LISTEN nova_pedra');
    console.log("👂 Escutando 'nova_pedra'...");

    // FIX #5: Detectar desconexão silenciosa e lançar erro para reiniciar
    client.on('error', (err) => {
        console.error('Erro no cliente PostgreSQL:', err);
        throw err;
    });

    client.on('end', () => {
        throw new Error('Conexão com PostgreSQL encerrada inesperadamente');
    });

    await new Promise<void>((_, reject) => {
        client.on('notification', async (msg) => {
            if (msg.channel !== 'nova_pedra' || !msg.payload) return;

            try {
                checkMidnightReset();

                const payload = JSON.parse(msg.payload);
                const newRoll: RollData = {
                    id: payload.id || `temp-${Date.now()}`,
                    timestamp: payload.created_at || new Date().toISOString(),
                    color: payload.color || 'Preto',
                    roll: parseInt(payload.roll)
                };

                // Deduplicação: ignorar a mesma pedra processada duas vezes
                if (history.length > 0 && history[history.length - 1].id === newRoll.id) {
                    return;
                }

                const calcResult = processAlgorithms(newRoll);
                if (!calcResult) return;

                const { levelPoints, isBranco } = calcResult;

                const messagesTelegram: string[] = [];

                // ── MÁQUINA DE ESTADOS ─────────────────────────────────────
                if (mestreState.status === 'active') {
                    mestreState.stones.push(newRoll.roll);

                    if (isBranco) {
                        // WIN
                        mestreState.status = 'win';
                        placarDiario.wins++;
                        // FIX #2: Só comemora se o sinal foi anunciado
                        if (mestreState.wasAnnounced) {
                            messagesTelegram.push(`🎯 <b>GREEEN NO MESTRE!</b> 💰\n\nPegamos o BRANCO na ${mestreState.step}ª entrada!\nNível da operação: 🔥 ${mestreState.level}\n\n<i>Lucro garantido! Que venha o próximo!</i> 🚀`);
                        }
                        // Aguarda 7s e busca novo sinal imediatamente
                        setTimeout(async () => {
                            mestreState = { status: 'standby', step: 0, level: 0, stones: [], wasAnnounced: false };
                            if (history.length > 0) {
                                const lastRoll = history[history.length - 1];
                                const recheck = processAlgorithms(lastRoll);
                                if (recheck && recheck.levelPoints >= 1) {
                                    const deveAnunciar = recheck.levelPoints >= REGRAS_TELEGRAM.MESTRE_FORCA_MINIMA;
                                    mestreState = { status: 'active', step: 1, level: recheck.levelPoints, stones: [], wasAnnounced: deveAnunciar };
                                    if (deveAnunciar) {
                                        await sendTelegramMessage(`🚨 <b>NOVO SINAL DO MESTRE</b> 🚨\n\n🔥 <b>Nível de Força: ${recheck.levelPoints}</b>\n\n<i>Gerenciamento é tudo, siga o plano!</i>`);
                                        await sendTelegramMessage(`👉 <b>Entrar no branco agora! 1/6</b>`);
                                    }
                                }
                            }
                        }, 7000);
                    } else {
                        if (mestreState.step < 6) {
                            mestreState.step++;

                            // FIX #2: Só avisa próxima entrada se o sinal foi anunciado
                            if (mestreState.wasAnnounced) {
                                // Upgrade de nível → reinicia da entrada 1
                                if (levelPoints > mestreState.level) {
                                    mestreState.level = levelPoints;
                                    mestreState.step = 1; // ← Volta para 1/6
                                    messagesTelegram.push(`⚡ <b>SINAL UPGRADE! Nível ${mestreState.level}</b>\nForça aumentou! Começando do zero nas entradas.`);
                                    messagesTelegram.push(`👉 <b>Entrar no branco agora! 1/6</b>`);
                                } else {
                                    messagesTelegram.push(`👉 <b>Entrar no branco agora! ${mestreState.step}/6</b>`);
                                }
                            }
                        } else {
                            // LOSS: chegou na pedra 7 sem branco
                            mestreState.status = 'loss';
                            placarDiario.losses++;
                            // FIX #2: Só avisa loss se o sinal foi anunciado
                            if (mestreState.wasAnnounced) {
                                messagesTelegram.push(`❌ <b>RED NO MESTRE</b> 📉\n\nInfelizmente o branco não veio nas 6 entradas de proteção.\n\n<i>Mantenha a calma e siga o gerenciamento à risca! O mercado é feito de ciclos, o próximo será nosso!</i> 💪`);
                            }
                            // Aguarda 7s e busca novo sinal imediatamente (sem precisar de nova pedra)
                            setTimeout(async () => {
                                mestreState = { status: 'standby', step: 0, level: 0, stones: [], wasAnnounced: false };
                                if (history.length > 0) {
                                    const lastRoll = history[history.length - 1];
                                    const recheck = processAlgorithms(lastRoll);
                                    if (recheck && recheck.levelPoints >= 1) {
                                        const deveAnunciar = recheck.levelPoints >= REGRAS_TELEGRAM.MESTRE_FORCA_MINIMA;
                                        mestreState = { status: 'active', step: 1, level: recheck.levelPoints, stones: [], wasAnnounced: deveAnunciar };
                                        if (deveAnunciar) {
                                            await sendTelegramMessage(`🚨 <b>NOVO SINAL DO MESTRE</b> 🚨\n\n🔥 <b>Nível de Força: ${recheck.levelPoints}</b>\n\n<i>Gerenciamento é tudo, siga o plano!</i>`);
                                            await sendTelegramMessage(`👉 <b>Entrar no branco agora! 1/6</b>`);
                                        }
                                    }
                                }
                            }, 7000);
                        }
                    }
                } else {
                    // Limpa estado de win/loss anterior para aceitar novo sinal
                    if (mestreState.status === 'win' || mestreState.status === 'loss') {
                        mestreState = { status: 'standby', step: 0, level: 0, stones: [], wasAnnounced: false };
                    }

                    // FIX #2: Só ativa operação para level >= 1, mas só anuncia se >= MESTRE_FORCA_MINIMA
                    if (levelPoints >= 1) {
                        const deveAnunciar = levelPoints >= REGRAS_TELEGRAM.MESTRE_FORCA_MINIMA;
                        mestreState = {
                            status: 'active',
                            step: 1,
                            level: levelPoints,
                            stones: [],
                            wasAnnounced: deveAnunciar, // ← Chave que resolve tudo
                        };

                        if (deveAnunciar) {
                            messagesTelegram.push(`🚨 <b>SINAL DO MESTRE DE CONFLUÊNCIA</b> 🚨\n\n🔥 <b>Nível de Força: ${levelPoints}</b>\n\n<i>Gerenciamento é tudo, siga o plano!</i>`);
                            messagesTelegram.push(`👉 <b>Entrar no branco agora! 1/6</b>`);
                        }
                    }
                }

                // Enviar mensagens
                for (const m of messagesTelegram) {
                    await sendTelegramMessage(m);
                }

                // Montar estado para o frontend
                const estadoMotor = {
                    mestreState,
                    placarDiario,
                    timestamp: new Date().toISOString(),
                    radarData: calcResult.engineState.radarData,
                    iaData: calcResult.engineState.iaData
                };

                // FIX #1: Salvar estado completo no banco (sobrevive a restarts)
                await salvarEstadoNoBanco(client, estadoMotor);

                // Notificar frontend via SSE
                await client.query('NOTIFY estado_motor');

            } catch (err) {
                console.error('Erro ao processar pedra:', err);
                reject(err); // FIX #5: Propaga para reiniciar o motor
            }
        });
    });
}

// Inicia o motor com reconexão automática
startEngine();
