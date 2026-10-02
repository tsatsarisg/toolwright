import { z } from "zod";

export const providerSchema = z.enum(["openai", "openai-compatible"]);
export const apiSchema = z.enum(["responses", "chat-completions"]);
const positiveInteger = z.number().int().positive();
const capabilitiesSchema = z
	.object({
		tools: z.boolean().optional(),
		streaming: z.boolean().optional(),
		hostedWebSearch: z.boolean().optional(),
	})
	.strict();
export const profileSchema = z
	.object({
		provider: providerSchema,
		api: apiSchema.optional(),
		baseURL: z.string().optional(),
		apiKeyEnv: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		contextWindow: positiveInteger.optional(),
		maxOutputTokens: positiveInteger.optional(),
		localOnly: z.boolean().optional(),
		telemetry: z.boolean().optional(),
		capabilities: capabilitiesSchema.optional(),
	})
	.strict();
export const configSchema = z
	.object({
		defaultProfile: z.string().min(1).optional(),
		profiles: z.record(z.string().min(1), profileSchema).optional(),
	})
	.strict();
// Project files cannot select credentials, endpoints, or relax local-only policy.
export const projectSchema = z
	.object({
		profile: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		contextWindow: positiveInteger.optional(),
		maxOutputTokens: positiveInteger.optional(),
	})
	.strict();

export type ProviderProfile = z.infer<typeof profileSchema>;
export type ProjectConfiguration = z.infer<typeof projectSchema>;
