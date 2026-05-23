export type ProviderPreset = {
	id: string;
	subtitle: string;
};

export type ProviderOption = {
	slug: 'openrouter' | 'openai' | 'anthropic';
	title: string;
	subtitle: string;
	envVar: string;
	defaultLLMModel: string;
	defaultImageModel?: string;
	imageProvider?: 'openrouter' | 'openai';
	llmPresets: ProviderPreset[];
	imagePresets: ProviderPreset[];
};

export const providers: ProviderOption[] = [
	{
		slug: 'openrouter',
		title: 'Use OpenRouter',
		subtitle: 'Recommended. Routes to GPT, Claude, Gemini, Grok, etc.',
		envVar: 'OPENROUTER_API_KEY',
		defaultLLMModel: 'openai/gpt-5.5',
		defaultImageModel: 'google/gemini-2.5-flash-image',
		imageProvider: 'openrouter',
		llmPresets: [
			{id: 'openai/gpt-5.5', subtitle: 'Recommended.'},
			{id: 'anthropic/claude-opus-4.7', subtitle: 'Anthropic max model.'},
			{id: 'anthropic/claude-sonnet-4.6', subtitle: 'Balanced.'},
			{id: 'google/gemini-3-flash-preview', subtitle: 'Fast thinking.'},
			{id: 'openai/gpt-5-mini', subtitle: 'Cheap + fast.'}
		],
		imagePresets: [
			{id: 'google/gemini-2.5-flash-image', subtitle: 'Recommended.'},
			{id: 'google/gemini-3-pro-image-preview', subtitle: 'Premium.'},
			{id: 'openai/gpt-5-image-mini', subtitle: 'Balanced.'},
			{id: 'openai/gpt-5.4-image-2', subtitle: 'Premium OpenAI.'}
		]
	},
	{
		slug: 'openai',
		title: 'Use OpenAI',
		subtitle: 'Direct OpenAI API. Has both chat and image.',
		envVar: 'OPENAI_API_KEY',
		defaultLLMModel: 'gpt-5.5',
		defaultImageModel: 'gpt-5.4-image-2',
		imageProvider: 'openai',
		llmPresets: [
			{id: 'gpt-5.5', subtitle: 'Recommended.'},
			{id: 'gpt-5', subtitle: 'Previous flagship.'},
			{id: 'gpt-5-mini', subtitle: 'Cheaper / faster.'},
			{id: 'gpt-4o', subtitle: 'Legacy multimodal.'}
		],
		imagePresets: [
			{id: 'gpt-5.4-image-2', subtitle: 'Recommended.'},
			{id: 'gpt-5-image', subtitle: 'Premium.'},
			{id: 'gpt-5-image-mini', subtitle: 'Balanced.'},
			{id: 'gpt-image-1', subtitle: 'Standard.'}
		]
	},
	{
		slug: 'anthropic',
		title: 'Use Anthropic',
		subtitle: 'Claude only. No image generation.',
		envVar: 'ANTHROPIC_API_KEY',
		defaultLLMModel: 'claude-sonnet-4.6',
		llmPresets: [
			{id: 'claude-opus-4.7', subtitle: 'Most capable.'},
			{id: 'claude-sonnet-4.6', subtitle: 'Balanced.'},
			{id: 'claude-haiku-4.5', subtitle: 'Cheap, fast.'}
		],
		imagePresets: []
	}
];

export function providerBySlug(slug: string) {
	return providers.find(provider => provider.slug === slug);
}
