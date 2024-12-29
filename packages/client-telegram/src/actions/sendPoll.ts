import { z } from "zod";
import {
    Action,
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    composeContext,
    generateObject,
    ModelClass,
    generateText
} from "@ai16z/eliza";
import { Context, Telegraf } from "telegraf";

// Add a type for poll response
interface PollResponse {
    question: string;
    options: string[];
}

export const sendPoll = {
    name: "SEND_POLL",
    description: "Creates and sends a poll in Telegram",
    similes: ["create poll", "make poll", "start poll"],
    examples: [[
        {
            user: "user1",
            content: { text: "Create a poll about this topic", source: "telegram" },
            assistant: "I'll create a poll for you"
        }
    ]],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const messageText = message.content.text?.toLowerCase() || '';
        const isValid = messageText.includes('/poll') ||
                       messageText.includes('send poll') ||
                       messageText.includes('create poll') ||
                       messageText.includes('make poll') ||
                       messageText.includes('start poll');

        elizaLogger.info(`Poll command validation:`, {
            text: messageText,
            isValid: isValid,
            action: message.content.action
        });

        if (isValid) {
            // Explicitly set the action when validated
            message.content.action = 'SEND_POLL';
        }

        return isValid;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        elizaLogger.info("🎯 SEND_POLL action handler triggered");

        try {
            const ctx = message.content.ctx as Context;
            if (!ctx || !ctx.chat) {
                elizaLogger.error("Invalid context for poll creation", { ctx });
                throw new Error("Invalid context for poll creation");
            }

            // Set the action explicitly
            message.content.action = 'SEND_POLL';
            state.currentAction = 'SEND_POLL';

            // Generate poll content using AI
            const pollContext = `You are ${runtime.character.name}.
                ${runtime.character.bio}

                Based on your personality and the conversation, create an engaging poll.
                Recent messages: ${state.recentMessages}
                Current message: ${message.content.text}

                Create a poll that matches your character's style with:
                1. A question (max 300 characters)
                2. 2-5 answer options (IMPORTANT: each option MUST be under 100 characters)

                Format:
                Question: [Your concise question here]
                - [Short option 1]
                - [Short option 2]
                - [Short option 3]

                Keep your unique voice but be brief. Each option MUST be under 100 characters.`;

            elizaLogger.info("Generating poll with context:", { messageText: message.content.text });
            const aiResponse = await generateText({
                runtime,
                context: pollContext,
                modelClass: ModelClass.SMALL
            });

            elizaLogger.info("AI Response:", aiResponse);

            // Initialize pollData first
            const pollData = {
                question: "",
                options: [] as string[]
            };

            // Parse the response
            const lines = aiResponse.split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .filter(line => !line.toLowerCase().includes('*question:*') && !line.toLowerCase().includes('*options:*'));

            if (lines.length >= 2) {
                pollData.question = lines[0].replace(/^(Question:|Q:|Poll:|\d+\.)\s*/i, '');
                pollData.options = lines.slice(1)
                    .map(line => line.replace(/^[-*•\d\.]\s*/, ''))
                    .filter(Boolean)
                    .filter(line => line !== pollData.question)
                    .slice(0, 5);
            } else {
                throw new Error("Invalid AI response format for poll");
            }

            elizaLogger.info("Sending poll:", pollData);

            try {
                const sentPoll = await ctx.telegram.sendPoll(
                    ctx.chat.id,
                    pollData.question,
                    pollData.options,
                    { is_anonymous: true }
                );

                // Store poll data in state
                state.recentPoll = {
                    id: sentPoll.message_id,
                    question: pollData.question,
                    options: pollData.options.map(opt => ({
                        text: opt,
                        voter_count: 0
                    }))
                };

                elizaLogger.info("Poll sent successfully:", {
                    pollId: sentPoll.message_id,
                    pollData: state.recentPoll
                });

                const response: Content = {
                    text: "I've created a poll for you! Please vote.",
                    action: "POLL_CREATED",
                    source: "telegram"
                };

                await callback(response);
                return true;

            } catch (sendError) {
                elizaLogger.error("Failed to send poll:", {
                    error: sendError.message,
                    stack: sendError.stack,
                    data: pollData
                });
                throw sendError;
            }

        } catch (error) {
            elizaLogger.error("Error in poll handler:", {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
};
