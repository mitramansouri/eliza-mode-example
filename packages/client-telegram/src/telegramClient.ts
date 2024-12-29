import { Context, Telegraf } from "telegraf";
import { message } from 'telegraf/filters';
import { IAgentRuntime, elizaLogger, Memory, stringToUuid, getEmbeddingZeroVector, Content, HandlerCallback } from "@ai16z/eliza";
import { MessageManager } from "./messageManager.ts";
import { getOrCreateRecommenderInBe } from "./getOrCreateRecommenderInBe.ts";
import { sendPoll } from "./actions/sendPoll.ts"; // Change from default to named import
import { proceedPoll } from "./actions/proceedPoll.ts";

interface PollOption {
    text: string;
    voter_count: number;
}

interface Poll {
    id: number;
    question: string;
    options: PollOption[];
}

export class TelegramClient {
    private botInstance: Telegraf<Context>;
    private runtime: IAgentRuntime;
    private messageManager: MessageManager;
    private backend;
    private backendToken;
    private tgTrader;
    private recentPoll: Poll | null = null;

    constructor(runtime: IAgentRuntime, botToken: string) {
        elizaLogger.log("📱 Constructing new TelegramClient...");
        this.runtime = runtime;
        this.botInstance = new Telegraf(botToken);
        this.messageManager = new MessageManager(this.botInstance, this.runtime);
        this.backend = runtime.getSetting("BACKEND_URL");
        this.backendToken = runtime.getSetting("BACKEND_TOKEN");
        this.tgTrader = runtime.getSetting("TG_TRADER"); // boolean To Be added to the settings
        elizaLogger.log("✅ TelegramClient constructor completed");
    }

    public get bot(): Telegraf<Context> {
        return this.botInstance;
    }

    public async start(): Promise<void> {
        elizaLogger.log("🚀 Starting Telegram bot...");
        try {
            await this.initializeBot();
            this.setupMessageHandlers();
            this.setupShutdownHandlers();

            // Register actions
            elizaLogger.info("Registering actions...");
            this.runtime.registerAction({
                ...sendPoll,
                handler: async (runtime, message, state, options, callback) =>
                    await sendPoll.handler(runtime, message, state, { ...options, botInstance: this.botInstance }, callback)
            });
            this.runtime.registerAction(proceedPoll);
            elizaLogger.info("Actions registered successfully");

        } catch (error) {
            elizaLogger.error("❌ Failed to launch Telegram bot:", error);
            throw error;
        }
    }

    private async initializeBot(): Promise<void> {
        this.botInstance.launch({ dropPendingUpdates: true });
        elizaLogger.log(
            "✨ Telegram bot successfully launched and is running!"
        );

        const botInfo = await this.botInstance.telegram.getMe();
        this.botInstance.botInfo = botInfo;
        elizaLogger.success(`Bot username: @${botInfo.username}`);

        this.messageManager.bot = this.botInstance;
    }

    private async isGroupAuthorized(ctx: Context): Promise<boolean> {
        const config = this.runtime.character.clientConfig?.telegram;
        if (ctx.from?.id === ctx.botInfo?.id) {
            return false;
        }

        if (!config?.shouldOnlyJoinInAllowedGroups) {
            return true;
        }

        const allowedGroups = config.allowedGroupIds || [];
        const currentGroupId = ctx.chat.id.toString();

        if (!allowedGroups.includes(currentGroupId)) {
            elizaLogger.info(`Unauthorized group detected: ${currentGroupId}`);
            try {
                await ctx.reply("Not authorized. Leaving.");
                await ctx.leaveChat();
            } catch (error) {
                elizaLogger.error(`Error leaving unauthorized group ${currentGroupId}:`, error);
            }
            return false;
        }

        return true;
    }

    private setupMessageHandlers(): void {
        elizaLogger.log("Setting up message handler...");

        this.botInstance.on(message('new_chat_members'), async (ctx) => {
            try {
                const newMembers = ctx.message.new_chat_members;
                const isBotAdded = newMembers.some(member => member.id === ctx.botInfo.id);

                if (isBotAdded && !(await this.isGroupAuthorized(ctx))) {
                    return;
                }
            } catch (error) {
                elizaLogger.error("Error handling new chat members:", error);
            }
        });
        //inja
        this.botInstance.command('poll', async (ctx) => {
            try {
                elizaLogger.info('Received /poll command');

                const message: Memory = {
                    id: stringToUuid(ctx.message.message_id.toString()),
                    userId: stringToUuid(ctx.from.id.toString()),
                    roomId: stringToUuid(ctx.chat.id.toString()),
                    agentId: this.runtime.agentId,
                    content: {
                        text: 'text' in ctx.message ? ctx.message.text : '',
                        ctx,
                        source: 'telegram',
                        action: 'SEND_POLL'  // Explicitly set the action
                    },
                    createdAt: Date.now(),
                    embedding: getEmbeddingZeroVector()
                };

                elizaLogger.debug('Created memory object for poll:', message);

                // Create initial state with SEND_POLL action
                const state = await this.runtime.composeState(message);
                state.currentAction = 'SEND_POLL';  // Set the action in state

                // Call the action handler directly
                await sendPoll.handler(
                    this.runtime,
                    message,
                    state,
                    {},
                    this.messageManager.handleMessage.bind(this.messageManager)
                );

            } catch (error) {
                elizaLogger.error('Error processing poll command:', error);
                await ctx.reply('An error occurred while creating the poll. Please try again later.');
            }
        });

        this.botInstance.on("message", async (ctx) => {
            try {
                // Check group authorization first
                if (!(await this.isGroupAuthorized(ctx))) {
                    return;
                }

                const messageText = ('text' in ctx.message ? ctx.message.text : '') || '';

                // Check for proceed command
                if (messageText.toLowerCase().includes('/proceed')) {
                    elizaLogger.info("Proceed command detected:", { messageText });

                    const message: Memory = {
                        id: stringToUuid(ctx.message.message_id.toString()),
                        userId: stringToUuid(ctx.from.id.toString()),
                        roomId: stringToUuid(ctx.chat.id.toString()),
                        agentId: this.runtime.agentId,
                        content: {
                            text: messageText,
                            ctx,
                            source: 'telegram',
                            action: 'PROCEED_POLL',
                            recentPoll: this.recentPoll
                        },
                        createdAt: Date.now(),
                        embedding: getEmbeddingZeroVector()
                    };

                    const state = await this.runtime.composeState(message);
                    state.currentAction = 'PROCEED_POLL';

                    await proceedPoll.handler(
                        this.runtime,
                        message,
                        state,
                        {},
                        async (response: Content) => {
                            elizaLogger.info("Sending proceed response:", response);
                            await ctx.reply(response.text);
                            return [];
                        }
                    );
                    return;
                }

                const isPollRequest = messageText.toLowerCase().includes('/poll') ||
                                    messageText.toLowerCase().includes('send poll') ||
                                    messageText.toLowerCase().includes('create poll') ||
                                    messageText.toLowerCase().includes('make poll') ||
                                    messageText.toLowerCase().includes('start poll');

                if (isPollRequest) {
                    elizaLogger.info("Poll request detected:", { messageText });

                    const message: Memory = {
                        id: stringToUuid(ctx.message.message_id.toString()),
                        userId: stringToUuid(ctx.from.id.toString()),
                        roomId: stringToUuid(ctx.chat.id.toString()),
                        agentId: this.runtime.agentId,
                        content: {
                            text: messageText,
                            ctx,
                            source: 'telegram',
                            action: 'SEND_POLL'
                        },
                        createdAt: Date.now(),
                        embedding: getEmbeddingZeroVector()
                    };

                    const state = await this.runtime.composeState(message);
                    state.currentAction = 'SEND_POLL';

                    await sendPoll.handler(
                        this.runtime,
                        message,
                        state,
                        {},
                        this.messageManager.handleMessage.bind(this.messageManager)
                    );
                    return;
                }

                await this.messageManager.handleMessage(ctx);
            } catch (error) {
                elizaLogger.error("❌ Error handling message:", error);
                // Don't try to reply if we've left the group or been kicked
                if (error?.response?.error_code !== 403) {
                    try {
                        await ctx.reply("An error occurred while processing your message.");
                    } catch (replyError) {
                        elizaLogger.error("Failed to send error message:", replyError);
                    }
                }
            }
        });

        this.botInstance.on("photo", (ctx) => {
            elizaLogger.log(
                "📸 Received photo message with caption:",
                ctx.message.caption
            );
        });

        this.botInstance.on("document", (ctx) => {
            elizaLogger.log(
                "📎 Received document message:",
                ctx.message.document.file_name
            );
        });

        this.botInstance.catch((err, ctx) => {
            elizaLogger.error(`❌ Telegram Error for ${ctx.updateType}:`, err);
            ctx.reply("An unexpected error occurred. Please try again later.");
        });

        // Add poll answer handler
        this.botInstance.on('poll_answer', async (pollAnswer) => {
            try {
                elizaLogger.info("📊 Received poll answer:", {
                    pollId: pollAnswer.pollAnswer.poll_id,
                    userId: pollAnswer.from.id,
                    options: pollAnswer.pollAnswer.option_ids
                });

                // If you need to track which option was most voted
                if (pollAnswer.pollAnswer.option_ids && pollAnswer.pollAnswer.option_ids.length > 0) {
                    elizaLogger.info("Selected options:", pollAnswer.pollAnswer.option_ids);

                    // You can store this in your runtime or process it further
                    // Note: You'll need to maintain a map of poll_id to poll options
                    // if you want to know the actual text of the selected options
                }
            } catch (error) {
                elizaLogger.error("Error handling poll answer:", error);
            }
        });

        // Add poll update handler
        this.botInstance.on('poll', (pollUpdate) => {
            elizaLogger.info("Poll update received:", {
                id: pollUpdate.poll.id,
                options: pollUpdate.poll.options
            });

            this.recentPoll = {
                id: parseInt(pollUpdate.poll.id),
                question: pollUpdate.poll.question,
                options: pollUpdate.poll.options.map(opt => ({
                    text: opt.text,
                    voter_count: opt.voter_count || 0
                }))
            };
        });
    }

    private setupShutdownHandlers(): void {
        const shutdownHandler = async (signal: string) => {
            elizaLogger.log(
                `⚠️ Received ${signal}. Shutting down Telegram bot gracefully...`
            );
            try {
                await this.stop();
                elizaLogger.log("🛑 Telegram bot stopped gracefully");
            } catch (error) {
                elizaLogger.error(
                    "❌ Error during Telegram bot shutdown:",
                    error
                );
                throw error;
            }
        };

        process.once("SIGINT", () => shutdownHandler("SIGINT"));
        process.once("SIGTERM", () => shutdownHandler("SIGTERM"));
        process.once("SIGHUP", () => shutdownHandler("SIGHUP"));
    }

    public async stop(): Promise<void> {
        elizaLogger.log("Stopping Telegram bot...");
        await this.botInstance.stop();
        elizaLogger.log("Telegram bot stopped");
    }
}
