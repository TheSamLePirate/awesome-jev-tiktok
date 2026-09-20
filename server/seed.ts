import type { Rule, WatchQuestion } from "../shared/protocol";
const ALL = ["transcript", "video", "chat"] as const;

// Hand-written starting point so jev ticks immediately; GLM extends and rewrites from here.
export const SEED_RULES: Rule[] = [
  { id: "r-hype", sources: [...ALL], text: "Track how hyped the room is right now.", createdAt: 0 },
  { id: "r-host-question", sources: ["transcript"], text: "Tell me when the streamer asks the chat a question or invites them to react.", createdAt: 0 },
  { id: "r-respond", sources: ["chat", "transcript"], text: "Tell me when there is a chat message the streamer should answer now.", createdAt: 0 },
  { id: "r-mood", sources: ["chat", "transcript"], text: "Watch the mood of the conversation between the host and the chat.", createdAt: 0 },
  { id: "r-moderation", sources: ["chat"], text: "Flag chat messages that are hostile, spam, or scams.", createdAt: 0 },
  { id: "r-question", sources: ["chat"], text: "Flag chat messages that ask the host a direct question.", createdAt: 0 },
];

export const SEED_QUESTIONS: WatchQuestion[] = [
  {
    id: "hype", sources: [...ALL], label: "Hype", ruleId: "r-hype", scope: "window",
    question: { type: "score", instructions: "How energetic is the live room right now, judging by chat pace, likes, gifts and the host's speech?", criteria: ["Flat: little activity, calm speech", "Warm: steady chat and some reactions", "Hot: fast chat, many likes or gifts, excited speech", "On fire: flood of messages, gifts, host shouting or celebrating"] },
    alert: { scoreAtLeast: 2 },
  },
  {
    id: "host_asks_chat", sources: ["transcript"], label: "Host asks chat", ruleId: "r-host-question", scope: "window",
    question: { type: "noul", instructions: "In the transcript, is the host currently asking the viewers a question or asking them to react (vote, comment, like, share)?", criteria: { true: "The host explicitly addresses viewers and asks for input or an action.", false: "The host is narrating, explaining, or talking to someone else." } },
    alert: { noulAbove: 0.7 },
  },
  {
    id: "should_respond", sources: ["chat", "transcript"], label: "Reply needed", ruleId: "r-respond", scope: "window",
    question: { type: "noul", instructions: "Among the recent chat messages, is there one the host should answer right now, such as a direct question or a request that is not yet addressed in the transcript?", criteria: { true: "A clear, unanswered question or request to the host exists in recent chat.", false: "Recent chat is reactions, greetings, or already handled." } },
    alert: { noulAbove: 0.7 },
  },
  {
    id: "mood", sources: ["chat", "transcript"], label: "Mood", ruleId: "r-mood", scope: "window",
    question: { type: "choice", instructions: "What is the dominant mood of the exchange between the host and the chat right now?", criteria: { fun: "Jokes, laughter, playful banter", focused: "Serious discussion or explanation, attentive chat", tense: "Disagreement, arguing, sarcasm, complaints", bored: "Low engagement, off-topic or repetitive chat" } },
    alert: { choices: ["tense"] },
  },
  {
    id: "msg_safety", sources: ["chat"], label: "Message safety", ruleId: "r-moderation", scope: "message",
    question: { type: "choice", instructions: "Classify this single chat message.", criteria: { fine: "Normal comment, reaction, question, or greeting", spam: "Repeated text, self-promotion, emoji floods, begging for follows", hostile: "Insults, harassment, slurs, threats toward the host or others", scam: "Links, giveaways, crypto or money offers, phishing" } },
    alert: { choices: ["hostile", "scam", "spam"] },
  },
  {
    id: "msg_question", sources: ["chat"], label: "Asks host", ruleId: "r-question", scope: "message",
    question: { type: "noul", instructions: "Is this chat message a direct question addressed to the host?", criteria: { true: "It asks the host something and expects an answer.", false: "It is a reaction, statement, or aimed at another viewer." } },
    alert: { noulAbove: 0.7 },
  },
];
