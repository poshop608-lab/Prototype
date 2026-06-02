import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { AuthProvider } from "@/components/auth/auth-provider";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return (
    <AuthProvider initialProfile={profile}>
      <div className="flex h-screen bg-sv-black overflow-hidden">
        {/* Desktop sidebar */}
        <div className="hidden md:flex flex-shrink-0">
          <Sidebar />
        </div>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto min-w-0">
          <div className="p-4 md:p-6 pb-24 md:pb-6 max-w-7xl mx-auto">
            {children}
          </div>
        </main>

        {/* Mobile bottom nav */}
        <div className="md:hidden">
          <MobileNav />
        </div>
      </div>
    </AuthProvider>
  );
}
