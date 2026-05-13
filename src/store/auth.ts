import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Profile } from "@/types/database";

interface AuthState {
  profile: Profile | null;
  isLoading: boolean;
  setProfile: (profile: Profile | null) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      profile: null,
      isLoading: true,
      setProfile: (profile) => set({ profile }),
      setLoading: (isLoading) => set({ isLoading }),
      reset: () => set({ profile: null, isLoading: false }),
    }),
    {
      name: "sv-auth",
      partialize: (state) => ({ profile: state.profile }),
    }
  )
);
