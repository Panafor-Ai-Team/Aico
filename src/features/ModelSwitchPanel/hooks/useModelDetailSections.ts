import { create } from 'zustand';

import type { ModelDetailPanelExpandedKey } from '@/store/global/initialState';

/**
 * Sections of the model detail popup that always start collapsed. Their open state is kept
 * in memory only — it survives hovering other models during the session, but is gone after
 * a page refresh — unlike the persisted sections (see MODEL_DETAIL_PANEL_EXPANDABLE_KEYS).
 */
export const SESSION_SECTION_KEYS = [
  'abilities',
  'pricing',
] as const satisfies readonly ModelDetailPanelExpandedKey[];

type SessionSectionKey = (typeof SESSION_SECTION_KEYS)[number];

const isSessionSectionKey = (key: ModelDetailPanelExpandedKey): key is SessionSectionKey =>
  (SESSION_SECTION_KEYS as readonly string[]).includes(key);

/** Split an accordion's expanded keys into the persisted ones and the in-memory ones. */
export const splitExpandedKeys = (keys: ModelDetailPanelExpandedKey[]) => ({
  persisted: keys.filter((key) => !isSessionSectionKey(key)),
  session: keys.filter(isSessionSectionKey),
});

interface ModelDetailSectionsState {
  openKeys: SessionSectionKey[];
  setOpenKeys: (keys: SessionSectionKey[]) => void;
}

export const useModelDetailSectionsStore = create<ModelDetailSectionsState>((set) => ({
  openKeys: [],
  setOpenKeys: (openKeys) => set({ openKeys }),
}));
