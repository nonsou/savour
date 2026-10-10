// React keys derived from the server's saved values for edit forms built from uncontrolled
// inputs. React 19 resets a form after a successful action, and an existing <select> ignores a
// changed defaultValue, so a reset would restore the value from first render (e.g. a member's
// old role). Keying the fields by the saved values remounts them with the refreshed defaults
// whenever the server data changes, while the form (and its status message) stays mounted.
export function savedStateKey(...parts: (string | number | boolean | null | undefined | string[])[]): string {
  return JSON.stringify(parts.map((p) => (Array.isArray(p) ? [...p].sort() : p ?? null)));
}

export function memberAccessKey(m: { role: string; all_locations: boolean; membership_locations: { location_id: string }[] }): string {
  return savedStateKey(m.role, m.all_locations, m.membership_locations.map((x) => x.location_id));
}
