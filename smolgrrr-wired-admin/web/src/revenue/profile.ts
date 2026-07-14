export type RevenueProfileMetadataOptions = {
  publicBaseUrl: string;
  lnurlUsername: string;
  name?: string | undefined;
  displayName?: string | undefined;
  about?: string | undefined;
  website?: string | undefined;
  picture?: string | undefined;
  banner?: string | undefined;
  nip05?: string | undefined;
};

export function buildRevenueProfileMetadata(options: RevenueProfileMetadataOptions): Record<string, string> {
  const name = options.name?.trim() || "Wired";
  const metadata: Record<string, string> = {
    name,
    display_name: options.displayName?.trim() || name,
    about: options.about?.trim() || "Proof-of-work posts routed through Wired.",
    lud16: `${options.lnurlUsername}@${new URL(options.publicBaseUrl).hostname}`,
  };
  for (const [key, value] of [
    ["website", options.website],
    ["picture", options.picture],
    ["banner", options.banner],
    ["nip05", options.nip05],
  ] as const) {
    const configured = value?.trim();
    if (configured) metadata[key] = configured;
  }
  return metadata;
}
