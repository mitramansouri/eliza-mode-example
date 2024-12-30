import { Context } from "telegraf";
import { Action, Memory, State, IAgentRuntime, HandlerCallback, elizaLogger, Content, generateText } from "@ai16z/eliza";
import { sendPoll } from "./sendPoll";

interface PollOption {
    text: string;
    voter_count: number;
}
interface Poll {
    id: string;
    messageId: number;
    question: string;
    options: PollOption[];
}
interface ExtendedContent extends Content {
    ctx?: Context;
    recentPoll?: Poll;
    pollResult?: string;
}
export const proceedPoll = {
    name: "PROCEED_POLL",
    description: "Process the results of the most recent poll",
    similes: ["proceed with poll", "check poll results"],
    examples: [[
        {
            user: "user1",
            content: { text: "/proceed", source: "telegram" }
        }
    ]],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const messageText = message.content.text?.toLowerCase() || '';
        const isValid = messageText.includes('/proceed');
        elizaLogger.info(`Proceed command validation:`, {
            text: messageText,
            isValid: isValid
        });
        return isValid;
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state: State, options: any, callback: HandlerCallback) => {
        try {
            const recentPoll = message.content.recentPoll as Poll;
            const ctx = message.content.ctx as Context;

            if (!recentPoll) {
                const response: ExtendedContent = {
                    text: "No recent poll found to process.",
                    action: "PROCEED_POLL_ERROR",
                    source: "telegram"
                };
                await callback(response);
                return false;
            }

            // First, stop the poll to get final vote counts
            try {
                await ctx.telegram.stopPoll(ctx.chat.id, recentPoll.messageId);
                elizaLogger.info("Poll closed successfully:", recentPoll.messageId);
            } catch (error) {
                elizaLogger.error("Error closing poll:", error);
                const response: ExtendedContent = {
                    text: "Failed to close the poll. Please try again.",
                    action: "PROCEED_POLL_ERROR",
                    source: "telegram"
                };
                await callback(response);
                return false;
            }

            // Check for tied votes
            const maxVotes = Math.max(...recentPoll.options.map(opt => opt.voter_count));
            const leadingOptions = recentPoll.options.filter(opt => opt.voter_count === maxVotes);

            if (leadingOptions.length > 1) {
                const response: ExtendedContent = {
                    text: `There's currently a tie between ${leadingOptions.map(opt => `"${opt.text}"`).join(' and ')} with ${maxVotes} votes each. Please create a new poll to break the tie.`,
                    action: "PROCEED_POLL_TIE",
                    source: "telegram"
                };
                await callback(response);
                return false;
            }

            // Get the winning option
            const winningOption = recentPoll.options.reduce((prev, current) =>
                (current.voter_count > prev.voter_count) ? current : prev
            );
            elizaLogger.info("Winning option:", winningOption);
            // Send the winning option announcement
            const response: ExtendedContent = {
                text: `The winning option was: "${winningOption.text}" with ${winningOption.voter_count} votes.`,
                action: "PROCEED_POLL_SUCCESS",
                source: "telegram",
                pollResult: winningOption.text
            };
            await callback(response);

            try {
                // Generate a shorter story-like response about the winning option
                const generatedContent = await generateText({
                    runtime,
                    context: `Create a brief, magical story (5-7 sentences) about what happens when we ${winningOption.text}. Keep it short but very interesting and engaging.`,
                    modelClass: "small"
                });

                if (generatedContent) {
                    const generatedText: ExtendedContent = {
                        text: generatedContent,
                        action: "PROCEED_POLL_TRANSITION",
                        source: "telegram"
                    };
                    await callback(generatedText);
                }
            } catch (genError) {
                elizaLogger.error("Error generating text:", genError);
                // Continue with poll creation even if text generation fails
            }

            // Trigger a new poll based on the winning option
            const newPollMessage: Memory = {
                ...message,
                content: {
                    text: `Create a poll about: ${winningOption.text}`,
                    ctx: message.content.ctx,
                    source: "telegram",
                    action: "SEND_POLL"
                }
            };
            const newState = await runtime.composeState(newPollMessage);
            await sendPoll.handler(runtime, newPollMessage, newState, options, callback);
            return true;
        } catch (error) {
            elizaLogger.error("Error processing poll results:", error);
            const errorResponse: ExtendedContent = {
                text: "Error processing poll results: " + error.message,
                action: "PROCEED_POLL_ERROR",
                source: "telegram"
            };
            await callback(errorResponse);
            return false;
        }
    }
} as Action;