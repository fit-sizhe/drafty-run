// Language-agnostic meta comment patterns
export const BINDINGID_PATTERN =
  /^\s*([#/]{1,2}|--)\s*\|\s*(DRAFTY-ID)-(\d{3})-(\d)$/m;

export const BARE_DRAFTYID_PATTERN = /^(DRAFTY-ID)-(\d{3})-(\d)$/;

export const TITLE_PATTERN = /^\s*([#/]{1,2}|--)\s*\|\s*title:\s*(.+)$/m;
