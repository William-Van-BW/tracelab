import { chatgptAdapter } from "./chatgpt";
import { claudeAdapter } from "./claude";
import { dumateAdapter } from "./dumate";
import { qoderAdapter, qoderCnAdapter } from "./qoder";
import { traeAdapter } from "./trae";
import { workbuddyAdapter } from "./workbuddy";

export const agentLogAdapters = [chatgptAdapter, claudeAdapter, workbuddyAdapter, traeAdapter, qoderAdapter, qoderCnAdapter, dumateAdapter];
