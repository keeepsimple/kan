import { createAuthEndpoint } from "better-auth/api";
import { socialProviderList } from "better-auth/social-providers";

export const configuredProviders = socialProviderList.reduce<
  Record<
    string,
    {
      clientId: string;
      clientSecret: string;
      appBundleIdentifier?: string;
      tenantId?: string;
      requireSelectAccount?: boolean;
      clientKey?: string;
      issuer?: string;
      // Google-specific optional hints
      hostedDomain?: string;
      hd?: string;
      // Login/link-only: never auto-create a user on sign-in (Discord).
      disableImplicitSignUp?: boolean;
    }
  >
>((acc, provider) => {
  const id = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
  const secret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`];
  if (id && id.length > 0 && secret && secret.length > 0) {
    acc[provider] = { clientId: id, clientSecret: secret };
  }
  if (
    provider === "apple" &&
    Object.keys(acc).includes("apple") &&
    acc[provider]
  ) {
    const bundleId =
      process.env[`${provider.toUpperCase()}_APP_BUNDLE_IDENTIFIER`];
    if (bundleId && bundleId.length > 0) {
      acc[provider].appBundleIdentifier = bundleId;
    }
  }
  if (
    provider === "gitlab" &&
    Object.keys(acc).includes("gitlab") &&
    acc[provider]
  ) {
    const issuer = process.env[`${provider.toUpperCase()}_ISSUER`];
    if (issuer && issuer.length > 0) {
      acc[provider].issuer = issuer;
    }
  }
  if (
    provider === "microsoft" &&
    Object.keys(acc).includes("microsoft") &&
    acc[provider]
  ) {
    acc[provider].tenantId = "common";
    acc[provider].requireSelectAccount = true;
  }
  // Add Google domain hint if allowed domains is configured
  if (
    provider === "google" &&
    Object.keys(acc).includes("google") &&
    acc[provider]
  ) {
    const allowed = process.env.BETTER_AUTH_ALLOWED_DOMAINS?.split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (allowed && allowed.length > 0) {
      // Use the first domain as an authorization hint
      acc[provider].hostedDomain = allowed[0];
      acc[provider].hd = allowed[0];
    }
  }
  if (
    provider === "tiktok" &&
    Object.keys(acc).includes("tiktok") &&
    acc[provider]
  ) {
    const key = process.env[`${provider.toUpperCase()}_CLIENT_KEY`];
    if (key && key.length > 0) {
      acc[provider].clientKey = key;
    }
  }
  // Discord is link/login-only: a sign-in for a user who has no account
  // will NOT auto-create one (registration must go through the normal flow).
  // Existing users can still log in, and members can link via profile settings.
  if (
    provider === "discord" &&
    Object.keys(acc).includes("discord") &&
    acc[provider]
  ) {
    acc[provider].disableImplicitSignUp = true;
  }
  return acc;
}, {});

export const socialProvidersPlugin = () => ({
  id: "social-providers-plugin",
  endpoints: {
    getSocialProviders: createAuthEndpoint(
      "/social-providers",
      {
        method: "GET",
      },
      async (ctx) => {
        const providers = ctx.context.socialProviders.map((p) =>
          p.id.toLowerCase(),
        );
        return ctx.json(providers);
      },
    ),
  },
});
