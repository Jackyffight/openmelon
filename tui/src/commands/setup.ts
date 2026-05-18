import {loadCredentials, loadUserConfig, saveCredentials, saveUserConfig} from '../core/config.js';
import {providerBySlug, providers} from '../core/providers.js';
import {runOnboardingWizard} from '../onboarding/Onboarding.js';

export async function runSetupCommand(args: string[]) {
	if (args.length === 0) {
		await runOnboardingWizard({forceAuth: true});
		return;
	}

	const parsed = parseSetupArgs(args);
	const provider = providerBySlug(parsed.provider || 'openrouter');
	if (!provider) {
		throw new Error(`unknown provider ${parsed.provider}`);
	}

	const key = parsed.key || process.env[provider.envVar];
	if (!key) {
		console.log('Usage: openmelon setup --provider <openrouter|openai|anthropic> --api-key <key> [--llm-model <model>] [--image-model <model|none>]');
		console.log('');
		console.log('Providers:');
		for (const item of providers) {
			console.log(`  ${item.slug.padEnd(10)} ${item.subtitle}`);
		}
		console.log('');
		console.log(`No key provided and ${provider.envVar} is not set.`);
		return;
	}

	const credentials = await loadCredentials();
	credentials.api_keys = {...credentials.api_keys, [provider.slug]: key};
	await saveCredentials(credentials);

	const config = await loadUserConfig();
	config.defaults = {
		...config.defaults,
		llm_provider: provider.slug,
		llm_model: parsed.llmModel || provider.defaultLLMModel,
		image_provider: parsed.imageModel === 'none' ? '' : provider.imageProvider || '',
		image_model: parsed.imageModel === 'none' ? '' : parsed.imageModel || provider.defaultImageModel || ''
	};
	await saveUserConfig(config);

	console.log(`Configured ${provider.slug}.`);
	console.log(`LLM model: ${config.defaults.llm_model}`);
	if (config.defaults.image_model) {
		console.log(`Image model: ${config.defaults.image_provider}:${config.defaults.image_model}`);
	} else {
		console.log('Image generation disabled.');
	}
}

function parseSetupArgs(args: string[]) {
	const out: {provider?: string; key?: string; llmModel?: string; imageModel?: string} = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case '--provider':
			case '-p':
				out.provider = args[++index];
				break;
			case '--api-key':
			case '--key':
				out.key = args[++index];
				break;
			case '--llm-model':
			case '--model':
				out.llmModel = args[++index];
				break;
			case '--image-model':
				out.imageModel = args[++index];
				break;
			default:
				throw new Error(`unknown setup argument ${arg}`);
		}
	}
	return out;
}
