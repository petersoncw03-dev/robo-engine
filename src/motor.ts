import { Client } from 'pg';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// BLOCO 2: REGRAS DO TELEGRAM E PLACAR DA MEIA-NOITE
// ============================================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Inicialização do Bot do Telegram
const bot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN, { polling: false }) : null;

const REGRAS_TELEGRAM = {
    // Enviar sinal apenas se Nível de Força for >= 2
    MESTRE_FORCA_MINIMA: 2,
    // (Qtd de entradas >= 2 AND Winrate >= 80%) OU (Qtd de entradas >= 3 AND Winrate >= 60%)
    IA_REGRA_1: { minEntradas: 2, minWinrate: 80 },
    IA_REGRA_2: { minEntradas: 3, minWinrate: 60 }
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
// BLOCO 1: GERENCIAMENTO DE MEMÓRIA E ESTADO (ANTI-TRAVAMENTO CPU)
// ============================================================================
interface RollData {
    id: string;
    timestamp: string;
    color: string;
    roll: number;
}

// "Sliding Window" - Máximo de 2000 pedras na memória RAM
const MAX_HISTORY = 2000;
const history: RollData[] = [];

interface MestreState {
    status: 'standby' | 'active' | 'win' | 'loss';
    step: number;
    level: number;
    stones: number[];
}

let mestreState: MestreState = {
    status: 'standby',
    step: 0,
    level: 0,
    stones: []
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
            sendTelegramMessage(`🌙 <b>Resumo do Dia - RoboBlaze</b>\n\n✅ Vitórias (Wins): ${placarDiario.wins}\n❌ Derrotas (Losses): ${placarDiario.losses}`);
        }
        
        // Resetando o placar para o novo dia
        placarDiario.wins = 0;
        placarDiario.losses = 0;
        placarDiario.lastResetDate = today;
        console.log('🔄 Placar diário resetado.');
    }
}

// ============================================================================
// BLOCO 3: TRANSIÇÃO DOS ALGORITMOS (FRONT -> BACKEND)
// ============================================================================
import { calculateRadar } from './engines/radarEngine';
import { calculateIA } from './engines/iaEngine';

function processAlgorithms(newRoll: RollData) {
    // 1. Manter a Janela Deslizante de 2.000 pedras
    history.push(newRoll);
    if (history.length > MAX_HISTORY) {
        history.shift();
    }

    // Precisamos de histórico para prever (warmup)
    if (history.length < 50) return null;

    const isBranco = newRoll.color.toLowerCase().includes('branco') || newRoll.roll === 0;
    
    // --- LÓGICAS REAIS (IMPORTADAS DAS ENGINES) ---
    
    // 1. Radar Engine (Mestre de Confluência: Padrões, Zonas Quentes, Casas Exatas)
    const radarData = calculateRadar(history);
    let points = radarData.radarPoints;

    // 2. IA Engine (Minutos Quentes, Cruzamentos, Zero Absoluto)
    const iaData = calculateIA(history);
    let iaApproved = iaData.iaApproved;

    // Regra de Aprovação Completa do Mestre:
    // Pelo menos 1 gatilho radar E ser validado por IA ou Zonas Quentes
    let finalMestreApproved = false;
    if (points >= 1 && (iaApproved || radarData.hasZonasQuentes)) {
        finalMestreApproved = true;
    } else {
        // Se a IA não aprovou, descartamos
        points = 0; 
    }

    // --- REGRAS IA (MINUTOS) PARA TELEGRAM (OPCIONAL/FUTURO) ---
    // (Ainda é possível rastrear winrate de estratégias ativas do IA)
    let iaTelegramSignal = false;
    let iaWinrate = 85; // mock para alertas isolados
    let iaEntradas = 2; // mock para alertas isolados
    
    if ((iaEntradas >= REGRAS_TELEGRAM.IA_REGRA_1.minEntradas && iaWinrate >= REGRAS_TELEGRAM.IA_REGRA_1.minWinrate) ||
        (iaEntradas >= REGRAS_TELEGRAM.IA_REGRA_2.minEntradas && iaWinrate >= REGRAS_TELEGRAM.IA_REGRA_2.minWinrate)) {
        iaTelegramSignal = true; 
    }

    return {
        levelPoints: finalMestreApproved ? points : 0,
        iaApproved: finalMestreApproved,
        isBranco,
        iaTelegramSignal,
        iaWinrate,
        iaEntradas,
        engineState: { radarData, iaData } // Exportamos para o Front ter visibilidade
    };
}

// ============================================================================
// BLOCO 4: EVENT LOOP E POSTGRESQL LISTEN + BLOCO 5: NOTIFY
// ============================================================================
async function startEngine() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log("🔥 Robo-Engine (Motor de Sinais) conectado ao PostgreSQL!");

        // Criar tabela de estado se não existir
        await client.query('CREATE TABLE IF NOT EXISTS engine_state (id INT PRIMARY KEY, state JSONB)');
        await client.query('INSERT INTO engine_state (id, state) VALUES (1, \'{}\') ON CONFLICT (id) DO NOTHING');

        // --- WARMUP (PREENCHER HISTÓRICO) ---
        try {
            console.log("⏳ Iniciando Warmup: Buscando últimas 2000 pedras...");
            const res = await client.query('SELECT id, color, roll, timestamp FROM results ORDER BY timestamp DESC LIMIT 2000');
            const rows = res.rows.reverse(); // Queremos as pedras na ordem cronológica
            for (const row of rows) {
                history.push({
                    id: row.id,
                    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
                    color: row.color,
                    roll: parseInt(row.roll)
                });
            }
            console.log(`✅ Warmup concluído: ${history.length} pedras em memória.`);
        } catch (err) {
            console.error("⚠️ Erro no warmup (banco vazio?):", err);
        }

        await client.query('LISTEN nova_pedra');
        console.log("👂 Escutando canal 'nova_pedra'...");

        client.on('notification', async (msg) => {
            if (msg.channel === 'nova_pedra' && msg.payload) {
                // Checagem de Meia-Noite
                checkMidnightReset();

                const payload = JSON.parse(msg.payload);
                const newRoll: RollData = {
                    id: payload.id || `temp-${Date.now()}`,
                    timestamp: payload.created_at || new Date().toISOString(),
                    color: payload.color || 'Preto',
                    roll: parseInt(payload.roll)
                };

                // Deduplicação (Evita que atualizações no banco processem a mesma pedra 2x no Motor)
                if (history.length > 0 && history[history.length - 1].id === newRoll.id) {
                    return;
                }

                const calcResult = processAlgorithms(newRoll);
                if (!calcResult) return; // Ainda em warmup

                const { levelPoints, iaApproved, isBranco, iaTelegramSignal, iaWinrate, iaEntradas } = calcResult;

                let messagesTelegram: string[] = [];

                // --- MÁQUINA DE ESTADOS: MESTRE DE CONFLUÊNCIA ---
                if (mestreState.status === 'active') {
                    mestreState.stones.push(newRoll.roll);
                    
                    if (isBranco) {
                        mestreState.status = 'win';
                        placarDiario.wins++;
                        messagesTelegram.push(`🎯 <b>GREEEN NO MESTRE!</b> 💰\n\nPegamos o BRANCO na ${mestreState.step}ª entrada!\nNível da operação: 🔥 ${mestreState.level}\n\n<i>Lucro garantido! Que venha o próximo!</i> 🚀`);
                    } else {
                        if (mestreState.step < 6) {
                            mestreState.step++; // Avança no Gale
                            
                            // Dispara a mensagem se a operação já tem força suficiente
                            if (mestreState.level >= REGRAS_TELEGRAM.MESTRE_FORCA_MINIMA || levelPoints >= REGRAS_TELEGRAM.MESTRE_FORCA_MINIMA) {
                                // Upgrade de sinal durante as entradas
                                if (levelPoints > mestreState.level) {
                                    mestreState.level = levelPoints;
                                    messagesTelegram.push(`⚡ <b>SINAL UPGRADE!</b>\nComeçaremos a fazer novas entradas com força total! O nível subiu para 🔥 <b>${mestreState.level}</b>.`);
                                }
                                messagesTelegram.push(`👉 <b>Entrar no branco agora! ${mestreState.step}/6</b>`);
                            }
                        } else {
                            mestreState.status = 'loss';
                            placarDiario.losses++;
                            messagesTelegram.push(`❌ <b>RED NO MESTRE</b> 📉\n\nInfelizmente o branco não veio nas 6 entradas de proteção.\n\n<i>Mantenha a calma e siga o gerenciamento à risca! O mercado é feito de ciclos, o próximo será nosso!</i> 💪`);
                        }
                    }
                } else {
                    // Após win ou loss, garantimos que volte para standby se vier nova pedra antes de um sinal
                    if (mestreState.status === 'win' || mestreState.status === 'loss') {
                        mestreState = { status: 'standby', step: 0, level: 0, stones: [] };
                    }

                    // Se encontrou gatilho e a confluência validou (levelPoints assumiu o valor)
                    if (levelPoints >= 1) {
                        mestreState = {
                            status: 'active',
                            step: 1,
                            level: levelPoints,
                            stones: []
                        };

                        // Bloco 2: Mestre de Confluência - Enviar sinal apenas se Nível de Força for >= 2 (ou 3)
                        if (levelPoints >= REGRAS_TELEGRAM.MESTRE_FORCA_MINIMA) {
                            messagesTelegram.push(`🚨 <b>SINAL DO MESTRE DE CONFLUÊNCIA</b> 🚨\n\n🔥 <b>Nível de Força: ${levelPoints}</b>\n\n<i>Gerenciamento é tudo, siga o plano!</i>`);
                            messagesTelegram.push(`👉 <b>Entrar no branco agora! 1/6</b>`);
                        }
                    }
                }

                // Disparo das Mensagens no Telegram
                for (const msg of messagesTelegram) {
                    await sendTelegramMessage(msg);
                }

                // TODO: Adicionar futuramente o envio do alerta isolado de IA (iaTelegramSignal)

                // 5. Notify para o Frontend e API
                // Empacotamos o estado
                const estadoMotor = {
                    mestreState,
                    placarDiario,
                    timestamp: new Date().toISOString(),
                    radarData: calcResult.engineState.radarData,
                    iaData: calcResult.engineState.iaData
                };

                // O payload JSON completo ultrapassa 8KB e crasha o NOTIFY do Postgres!
                // Solução: Salvar o estado em uma tabela e avisar o Front para ler de lá.
                await client.query('UPDATE engine_state SET state = $1 WHERE id = 1', [JSON.stringify(estadoMotor)]);
                
                // NOTIFY no Postgres - apenas sinalizando que há um novo estado
                await client.query('NOTIFY estado_motor');
            }
        });

    } catch (error) {
        console.error("Erro fatal no Event Loop do Motor:", error);
    }
}

// Inicia o motor
startEngine();
