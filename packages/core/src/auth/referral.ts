interface ReferralInfo {
  affiliateToken: string;
  /**
   * The exact OAuth parameter name to use when forwarding the token to the
   * sign-up URL. Preserved from the referral link for the four standard
   * aliases (t, affiliate_token, sidi, ca). Defaults to 't' for formats
   * that don't use an OAuth alias directly (sidc, track.deriv.com).
   */
  affiliateTokenParam: 't' | 'affiliate_token' | 'sidi' | 'ca';
  utmCampaign: string;
  utmSource?: string;
  utmMedium?: string;
}

/**
 * Parse a Deriv partner referral link and extract affiliate tracking params.
 *
 * Supports three formats:
 * 1. deriv.com/signup?sidc=TOKEN&utm_campaign=dynamicworks[&utm_source=...&utm_medium=...]
 *    → affiliateToken = sidc value, affiliateTokenParam = 't' (sidc is not an OAuth alias),
 *      plus any utm_* params present
 *
 * 2. track.deriv.com/_TOKEN_/1/
 *    → affiliateToken = TOKEN (path segment without underscores),
 *      affiliateTokenParam = 't', utmCampaign = 'myaffiliates'
 *
 * 3. deriv.com/?t=TOKEN (or affiliate_token / sidi / ca)
 *    → affiliateToken = token value, affiliateTokenParam = the exact param name used,
 *      utmSource, utmMedium, utmCampaign from query params
 */
export function parseReferralLink(referralLink: string): ReferralInfo | null {
  if (!referralLink) return null;

  try {
    const url = new URL(referralLink);

    // Format 3: standard OAuth token aliases — preserve the exact param name used.
    // Checked in priority order; the first one present wins.
    const TOKEN_ALIASES = ['t', 'affiliate_token', 'sidi', 'ca'] as const;
    for (const param of TOKEN_ALIASES) {
      const value = url.searchParams.get(param);
      if (value) {
        return {
          affiliateToken: value,
          affiliateTokenParam: param,
          utmCampaign: url.searchParams.get('utm_campaign') ?? '',
          utmSource: url.searchParams.get('utm_source') ?? undefined,
          utmMedium: url.searchParams.get('utm_medium') ?? undefined,
        };
      }
    }

    // Format 1: deriv.com/signup?sidc=...&utm_campaign=... (DynamicWorks platform)
    // sidc is not an OAuth alias — forward the token as 't'.
    const sidc = url.searchParams.get('sidc');
    if (sidc) {
      return {
        affiliateToken: sidc,
        affiliateTokenParam: 't',
        utmCampaign: url.searchParams.get('utm_campaign') ?? 'dynamicworks',
        utmSource: url.searchParams.get('utm_source') ?? undefined,
        utmMedium: url.searchParams.get('utm_medium') ?? undefined,
      };
    }

    // Format 2: track.deriv.com/_TOKEN_/1/
    if (url.hostname.includes('track.deriv.com')) {
      const pathSegments = url.pathname.split('/').filter(Boolean);
      if (pathSegments.length > 0) {
        // Remove leading/trailing underscores from the token segment
        const rawToken = pathSegments[0].replace(/^_|_$/g, '');
        if (rawToken) {
          return {
            affiliateToken: rawToken,
            affiliateTokenParam: 't',
            utmCampaign: 'myaffiliates',
          };
        }
      }
    }
  } catch {
    // Invalid URL
  }

  return null;
}
