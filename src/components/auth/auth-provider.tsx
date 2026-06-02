"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/store/auth";
import type { Profile } from "@/types/database";

export function AuthProvider({
  children,
  initialProfile,
}: {
  children: React.ReactNode;
  initialProfile: Profile | null;
}) {
  const { setProfile, setLoading } = useAuthStore();

  useEffect(() => {
    setProfile(initialProfile);
    setLoading(false);
  }, [initialProfile, setProfile, setLoading]);

  return <>{children}</>;
}
