export function acceptedBaselineClaimText(canonicalClaim) {
  return String(canonicalClaim ?? '').replace(/\s+/gu, ' ').trim();
}

export function acceptedBaselineClaimLine({
  claimKind,
  canonicalClaim,
}) {
  return `- \`${claimKind}\` ${acceptedBaselineClaimText(canonicalClaim)}`;
}
