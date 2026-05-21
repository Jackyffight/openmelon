export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
	role: ChatRole;
	content?: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
};

export type ToolCall = {
	id: string;
	name: string;
	arguments: unknown;
};

export type ToolSpec = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
};

export type ChatUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
};

export type ChatResponse = {
	message: ChatMessage;
	finish_reason: 'stop' | 'tool_calls' | 'length' | 'other';
	usage: ChatUsage;
};

export type ProviderConnection = {
	provider: 'openai' | 'openrouter' | 'anthropic';
	model: string;
	apiKey: string;
	baseURL: string;
	reasoning: string;
};

export type ImageConnection = {
	provider: 'openai' | 'openrouter';
	model: string;
	apiKey: string;
	baseURL: string;
} | null;

export type NativeRuntimeContext = {
	workdir: string;
	projectId: string;
	projectName: string;
	projectDescription: string;
	projectPersona: string;
	projectConstraints: string[];
	bashMode: 'strict' | 'auto' | 'trusted';
	llm: ProviderConnection;
	image: ImageConnection;
	sessionId: string;
	sessionDir: string;
	outputDir: string;
	approve(req: {id: string; tool: string; command: string; description: string; binary: string}): Promise<{approved: boolean; always: boolean}>;
};

export type NativeTool = {
	spec: ToolSpec;
	dispatch(args: unknown, signal: AbortSignal): Promise<unknown>;
};
