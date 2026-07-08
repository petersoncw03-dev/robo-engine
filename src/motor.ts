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
    MESTRE_FORCA_MINIMA: 3,
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
    wasAnnounced: boolean;
}

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

function getPoints(radarData: any, iaData1h: any, iaData3h: any) {
    const currentConfluences = iaData3h.currentIaScore;
    let iaPoints = 0;
    
    if (currentConfluences >= 1) {
        const stat1h = iaData1h.stats.find((s: any) => s.conf === currentConfluences);
        const stat3h = iaData3h.stats.find((s: any) => s.conf === currentConfluences);
        const wr1 = stat1h ? stat1h.winRate : 0;
        const wr3 = stat3h ? stat3h.winRate : 0;
        const maxWinrate = Math.max(wr1, wr3);
        
        if (maxWinrate > 60) iaPoints = 4;
        else if (maxWinrate > 45) iaPoints = 3;
        else if (maxWinrate > 38) iaPoints = 2;
        else if (maxWinrate > 33) iaPoints = 1;
    }
    
    const totalPoints = radarData.radarPoints + iaPoints;
    const isSinalMaster = (currentConfluences >= 3 && iaPoints >= 1);
    
    let finalApproved = false;
    if (isSinalMaster || totalPoints >= 3) {
        finalApproved = true;
    }

    return { totalPoints, finalApproved, isSinalMaster };
}

function recheckSignal() {
    if (history.length < 50) return null;
    const radarData = calculateRadar(history);
    const iaData3h = calculateIA(history, 3);
    const iaData1h = calculateIA(history, 1);
    
    const { totalPoints, finalApproved } = getPoints(radarData, iaData1h, iaData3h);

    return { levelPoints: finalApproved ? totalPoints : 0, engineState: { radarData, iaData: iaData3h } };
}

function processAlgorithms(newRoll: RollData) {
    history.push(newRoll);
    if (history.length > MAX_HISTORY) {
        history.shift();
    }

    if (history.length < 50) return null;

    const isBranco = newRoll.color.toLowerCase().includes('branco') || newRoll.roll === 0;

    const radarData = calculateRadar(history);
    const iaData3h = calculateIA(history, 3);
    const iaData1h = calculateIA(history, 1);

    const { totalPoints, finalApproved } = getPoints(radarData, iaData1h, iaData3h);

    return {
        levelPoints: finalApproved ? totalPoints : 0,
        isBranco,
        engineState: { radarData, iaData: iaData3h }
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

function getFireEmojis(level: number) {
    if (level >= 6) return '🔥🔥🔥🔥🔥🔥';
    if (level >= 4) return '🔥🔥🔥🔥';
    return '🔥🔥🔥';
}

async function runEngine() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });

    await client.connect();
    console.log('🔥 Robo-Engine conectado ao PostgreSQL!');

    await client.query('CREATE TABLE IF NOT EXISTS engine_state (id INT PRIMARY KEY, state JSONB)');
    await client.query("INSERT INTO engine_state (id, state) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING");

    await restaurarEstadoDoBanco(client);

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

                if (history.length > 0 && history[history.length - 1].id === newRoll.id) {
                    return;
                }

                const calcResult = processAlgorithms(newRoll);
                if (!calcResult) return;

                const { levelPoints, isBranco } = calcResult;

                const messagesTelegram: string[] = [];

                if (mestreState.status === 'active') {
                    mestreState.stones.push(newRoll.roll);

                    if (isBranco) {
                        mestreState.status = 'win';
                        placarDiario.wins++;
                        if (mestreState.wasAnnounced) {
                            messagesTelegram.push(`🎯 <b>GREEEN NO MESTRE!</b> 💰\n\nPegamos o BRANCO na ${mestreState.step}ª entrada!\nNível da operação: ${getFireEmojis(mestreState.level)}\n\n<i>Lucro garantido! Que venha o próximo!</i> 🚀`);
                        }
                        setTimeout(async () => {
                            mestreState = { status: 'standby', step: 0, level: 0, stones: [], wasAnnounced: false };
                            const recheck = recheckSignal();
                            if (recheck && recheck.levelPoints >= REGRAS_TELEGRAM.MESTRE_FORCA_MINIMA) {
                                const deveAnunciar = true;
                                mestreState = { status: 'active', step: 1, level: recheck.levelPoints, stones: [], wasAnnounced: deveAnunciar };
                                await sendTelegramMessage(`🚨 <b>NOVO SINAL DO MESTRE</b> 🚨\n\n${getFireEmojis(recheck.levelPoints)} <b>Nível de Força: ${recheck.levelPoints} Pontos</b>\n\n<i>Gerenciamento é tudo, siga o plano!</i>`);
                                await sendTelegramMessage(`👉 <b>Entrar no branco agora! 1/6</b>`);
                            }
                        }, 7000);
                    } else {
                        if (mestreState.step < 6) {
                            mestreState.step++;

                            if (mestreState.wasAnnounced) {
                                if (levelPoints > mestreState.level) {
                                    mestreState.level = levelPoints;
                                    mestreState.step = 1;
                                    messagesTelegram.push(`⚡ <b>SINAL UPGRADE! Nível ${mestreState.level} Pontos ${getFireEmojis(mestreState.level)}</b>\nForça aumentou! Começando do zero nas entradas.`);
                                    messagesTelegram.push(`👉 <b>Entrar no branco agora! 1/6</b>`);
                                } else {
                                    messagesTelegram.push(`👉 <b>Entrar no branco agora! ${mestreState.step}/6</b>`);
                                }
                            }
                        } else {
                            mestreState.status = 'loss';
                            placarDiario.losses++;
                            if (mestreState.wasAnnounced) {
                                messagesTelegram.push(`❌ <b>RED NO MESTRE</b> 📉\n\nInfelizmente o branco não veio nas 6 entradas de proteção.\n\n<i>Mantenha a calma e siga o gerenciamento à risca! O mercado é feito de ciclos, o próximo será nosso!</i> 💪`);
                            }
                            setTimeout(async () => {
                                mestreState = { status: 'standby', step: 0, level: 0, stones: [], wasAnnounced: false };
                                const recheck = recheckSignal();
                                if (recheck && recheck.levelPoints >= REGRAS_TELEGRAM.MESTRE_FORCA_MINIMA) {
                                    const deveAnunciar = true;
                                    mestreState = { status: 'active', step: 1, level: recheck.levelPoints, stones: [], wasAnnounced: deveAnunciar };
                                    await sendTelegramMessage(`🚨 <b>NOVO SINAL DO MESTRE</b> 🚨\n\n${getFireEmojis(recheck.levelPoints)} <b>Nível de Força: ${recheck.levelPoints} Pontos</b>\n\n<i>Gerenciamento é tudo, siga o plano!</i>`);
                                    await sendTelegramMessage(`👉 <b>Entrar no branco agora! 1/6</b>`);
                                }
                            }, 7000);
                        }
                    }
                } else {
                    if (mestreState.status === 'win' || mestreState.status === 'loss') {
                        mestreState = { status: 'standby', step: 0, level: 0, stones: [], wasAnnounced: false };
                    }

                    if (levelPoints >= REGRAS_TELEGRAM.MESTRE_FORCA_MINIMA) {
                        const deveAnunciar = true;
                        mestreState = {
                            status: 'active',
                            step: 1,
                            level: levelPoints,
                            stones: [],
                            wasAnnounced: deveAnunciar,
                        };

                        messagesTelegram.push(`🚨 <b>SINAL DO MESTRE DE CONFLUÊNCIA</b> 🚨\n\n${getFireEmojis(levelPoints)} <b>Nível de Força: ${levelPoints} Pontos</b>\n\n<i>Gerenciamento é tudo, siga o plano!</i>`);
                        messagesTelegram.push(`👉 <b>Entrar no branco agora! 1/6</b>`);
                    }
                }

                for (const m of messagesTelegram) {
                    await sendTelegramMessage(m);
                }

                const estadoMotor = {
                    mestreState,
                    placarDiario,
                    timestamp: new Date().toISOString(),
                    radarData: calcResult.engineState.radarData,
                    iaData: calcResult.engineState.iaData
                };

                await salvarEstadoNoBanco(client, estadoMotor);

                await client.query('NOTIFY estado_motor');

            } catch (err) {
                console.error('Erro ao processar pedra:', err);
                reject(err);
            }
        });
    });
}

startEngine();
