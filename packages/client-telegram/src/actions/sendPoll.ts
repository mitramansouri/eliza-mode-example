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
        const isValid = message.content.action === 'SEND_POLL' ||
                       message.content.text?.toLowerCase().includes('/poll') ||
                       message.content.text?.toLowerCase().includes('/sendpoll') ||
                       message.content.text?.toLowerCase().includes('create poll') ||
                       message.content.text?.toLowerCase().includes('make poll') ||
                       message.content.text?.toLowerCase().includes('start poll');

        elizaLogger.info(`Poll command validation: ${isValid}, action: ${message.content.action}`);
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
        elizaLogger.debug("Message content:", message.content);

        try {
            const ctx = message.content.ctx as Context;
            if (!ctx || !ctx.chat) {
                elizaLogger.error("Invalid context for poll creation");
                throw new Error("Invalid context for poll creation");
            }

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

            elizaLogger.info("Generating poll content for character:", {
                character: runtime.character.name,
                recentMessages: state.recentMessages,
                currentMessage: message.content.text
            });
            const aiResponse = await generateText({
                runtime,
                context: pollContext,
                modelClass: ModelClass.SMALL
            });

            // Parse the response to extract question and options
            const pollData = {
                question: "",
                options: [] as string[]
            };

            const lines = aiResponse.split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .filter(line => !line.toLowerCase().includes('*question:*') && !line.toLowerCase().includes('*options:*')); // Filter out headers

            if (lines.length >= 3) {
                pollData.question = lines[0].replace(/^(Question:|Q:|Poll:|\d+\.)\s*/i, '');
                pollData.options = lines.slice(1)
                    .map(line => line.replace(/^[-*•\d\.]\s*/, '')) // Remove bullets and numbers
                    .filter(Boolean)
                    .filter(line => line !== pollData.question) // Ensure option isn't the same as question
                    .slice(0, 5);
            } else {
                elizaLogger.error("Invalid poll format from AI");
                throw new Error("Failed to generate valid poll options");
            }

            elizaLogger.info("Generated poll data:", pollData);

            // Send the poll
            await ctx.telegram.sendPoll(
                ctx.chat.id,
                pollData.question,
                pollData.options,
                { is_anonymous: true }
            );

            elizaLogger.info("Poll sent successfully");

            const response: Content = {
                text: "I've created a poll based on our conversation! Please vote.",
                action: "POLL_CREATED",
                source: "telegram"
            };

            await callback(response);
            return true;

        } catch (error) {
            elizaLogger.error("❌ Error in SEND_POLL handler:", error);
            throw error;
        }
    }
};
