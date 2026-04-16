import { invokeCmd } from "./tauri";

export type ProfileConfig =
  | { kind: "wechat_work"; webhook_url: string }
  | { kind: "notion"; token: string; parent_page_id: string }
  | { kind: "telegram"; bot_token: string; chat_id: string }
  | { kind: "webhook"; url: string; headers: string | null };

export type DestinationProfile = {
  id: string;
  name: string;
  last_used_ms: number | null;
  config: ProfileConfig;
};

export const PROFILE_KIND_LABEL: Record<ProfileConfig["kind"], string> = {
  wechat_work: "💼 WeChat Work",
  notion: "📚 Notion",
  telegram: "💬 Telegram",
  webhook: "🔗 Webhook",
};

export async function listProfiles(): Promise<DestinationProfile[]> {
  return invokeCmd<DestinationProfile[]>("list_destination_profiles");
}

export async function saveProfile(profile: DestinationProfile): Promise<void> {
  await invokeCmd<void>("save_destination_profile", { profile });
}

export async function deleteProfile(id: string): Promise<void> {
  await invokeCmd<void>("delete_destination_profile", { id });
}

export async function testWeworkWebhook(webhookUrl: string): Promise<string> {
  return invokeCmd<string>("test_wework_webhook", { webhookUrl });
}

export async function sendViaProfile(
  profileId: string,
  body: string
): Promise<string> {
  return invokeCmd<string>("send_via_profile", { profileId, body });
}

export function newProfileId(): string {
  return `dp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
