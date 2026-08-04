import { useProfile } from '../context/ProfileContext'

// Single source of truth for "what branch may this verifier see" and the
// fail-closed guard around it. Returns `scope: null` for an all-branches
// user (meaning "don't filter"), or the exact pickupBranch string to
// scope every query to. `blocked` is a ready-to-render reason string,
// never a raw boolean, so every screen using this shows the same wording.
export function useBranchScope() {
  const { pickupBranch, isAllBranches, loading, error } = useProfile()

  const resolved = !loading
  const misconfigured = resolved && !isAllBranches && !pickupBranch
  const scope = isAllBranches ? null : pickupBranch || null

  return {
    loading,
    error,
    misconfigured,
    scope,
    label: isAllBranches ? 'All Branches' : pickupBranch,
    blockedMessage: misconfigured
      ? "Your account isn't assigned to a branch. Ask an admin to set your branch in your profile."
      : null,
  }
}