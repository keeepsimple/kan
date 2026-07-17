const DISCORD_API = "https://discord.com/api/v10";

// View Channels (1<<10) + Send Messages (1<<11) + Mention Everyone (1<<17)
// + Create Public Threads (1<<35) + Send Messages in Threads (1<<38)
export const BOT_PERMISSIONS = "309237779456";

export const isDiscordConfigured = () => !!process.env.DISCORD_BOT_TOKEN;

export const getBotInviteUrl = (): string | null => {
  const clientId = process.env.DISCORD_BOT_CLIENT_ID;
  if (!clientId) return null;
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${BOT_PERMISSIONS}`;
};

export interface DiscordResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

export interface DiscordRole {
  id: string;
  name: string;
  managed: boolean;
}

export interface DiscordThread {
  id: string;
  name: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
}

export interface DiscordEmbed {
  title?: string;
  /** Makes the embed title a clickable link. */
  url?: string;
  description?: string;
  color?: number;
  author?: { name: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

const discordFetch = async <T>(
  path: string,
  init?: RequestInit,
): Promise<DiscordResult<T>> => {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken)
    return { success: false, error: "DISCORD_BOT_TOKEN is not set" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: `${response.status} ${body.slice(0, 300)}`,
      };
    }

    return { success: true, data: (await response.json()) as T };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

export const getGuild = (guildId: string) =>
  discordFetch<DiscordGuild>(`/guilds/${guildId}`);

export const getTextChannels = async (
  guildId: string,
): Promise<DiscordResult<DiscordChannel[]>> => {
  const result = await discordFetch<DiscordChannel[]>(
    `/guilds/${guildId}/channels`,
  );
  if (!result.success || !result.data) return result;
  // type 0 = guild text channel
  return { success: true, data: result.data.filter((c) => c.type === 0) };
};

export const getRoles = async (
  guildId: string,
): Promise<DiscordResult<DiscordRole[]>> => {
  const result = await discordFetch<DiscordRole[]>(`/guilds/${guildId}/roles`);
  if (!result.success || !result.data) return result;
  // Drop @everyone (same id as the guild) and bot-managed roles
  return {
    success: true,
    data: result.data.filter((r) => r.id !== guildId && !r.managed),
  };
};

export const createThread = (channelId: string, name: string) =>
  discordFetch<DiscordThread>(`/channels/${channelId}/threads`, {
    method: "POST",
    body: JSON.stringify({
      // Discord caps thread names at 100 chars
      name: name.slice(0, 100),
      type: 11, // public thread
      auto_archive_duration: 10080,
    }),
  });

export const postMessage = (
  channelOrThreadId: string,
  content: string,
  mentionRoleIds: string[] = [],
  embeds: DiscordEmbed[] = [],
  mentionUserIds: string[] = [],
) =>
  discordFetch<DiscordMessage>(`/channels/${channelOrThreadId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: {
        parse: [],
        roles: mentionRoleIds,
        users: mentionUserIds,
      },
      ...(embeds.length ? { embeds } : {}),
    }),
  });

/** Edits only the embeds of a previously posted message (content untouched). */
export const editMessage = (
  channelOrThreadId: string,
  messageId: string,
  embeds: DiscordEmbed[],
) =>
  discordFetch<DiscordMessage>(
    `/channels/${channelOrThreadId}/messages/${messageId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ embeds }),
    },
  );

export const buildRoleMentions = (roleIds: string[]) =>
  roleIds.map((id) => `<@&${id}>`).join(" ");

export const buildUserMentions = (userIds: string[]) =>
  userIds.map((id) => `<@${id}>`).join(" ");

interface DiscordGuildMember {
  user: { id: string; username: string; global_name: string | null };
  nick: string | null;
}

export const searchGuildMembers = async (
  guildId: string,
  query: string,
): Promise<
  DiscordResult<{ id: string; username: string; displayName: string }[]>
> => {
  const res = await discordFetch<DiscordGuildMember[]>(
    `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=25`,
  );
  if (!res.success || !res.data) return { success: false, error: res.error };
  return {
    success: true,
    data: res.data.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      displayName: m.nick ?? m.user.global_name ?? m.user.username,
    })),
  };
};

export const getUser = async (
  userId: string,
): Promise<
  DiscordResult<{ id: string; username: string; displayName: string }>
> => {
  const res = await discordFetch<{
    id: string;
    username: string;
    global_name: string | null;
  }>(`/users/${userId}`);
  if (!res.success || !res.data) return { success: false, error: res.error };
  return {
    success: true,
    data: {
      id: res.data.id,
      username: res.data.username,
      displayName: res.data.global_name ?? res.data.username,
    },
  };
};
