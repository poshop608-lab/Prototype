"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Eye, EyeOff, Loader2, Scan } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function RegisterPage() {
  const router = useRouter();
  const supabase = createClient();
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    fullName: "",
    role: "worker",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signUp({
      email: formData.email,
      password: formData.password,
      options: {
        data: {
          full_name: formData.fullName,
          role: formData.role,
        },
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  }

  if (success) {
    return (
      <div className="min-h-screen bg-sv-black flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center max-w-sm"
        >
          <div className="w-16 h-16 rounded-full bg-sv-green/20 border border-sv-green/40 flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-sv-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-semibold text-sv-white mb-2">Check your email</h2>
          <p className="text-sv-gray-400 text-sm mb-8">
            We sent a confirmation link to <span className="text-sv-white">{formData.email}</span>
          </p>
          <Link href="/login">
            <Button variant="outline">Back to sign in</Button>
          </Link>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-sv-black flex items-center justify-center px-4">
      <div
        className="fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-sm relative"
      >
        <div className="flex items-center gap-3 mb-10">
          <div className="w-9 h-9 rounded-lg bg-sv-white flex items-center justify-center">
            <Scan className="w-5 h-5 text-sv-black" />
          </div>
          <div>
            <div className="text-sv-white font-semibold text-lg leading-none">
              StrideVision
            </div>
            <div className="text-sv-gray-400 text-xs tracking-widest uppercase mt-0.5">
              AI Measurement
            </div>
          </div>
        </div>

        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-sv-white">Create account</h1>
          <p className="text-sv-gray-400 text-sm mt-1">
            Join your factory measurement team
          </p>
        </div>

        <form onSubmit={handleRegister} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-sv-gray-300 uppercase tracking-wider">
              Full Name
            </label>
            <Input
              type="text"
              value={formData.fullName}
              onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
              placeholder="Alex Johnson"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-sv-gray-300 uppercase tracking-wider">
              Email
            </label>
            <Input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              placeholder="worker@factory.com"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-sv-gray-300 uppercase tracking-wider">
              Role
            </label>
            <Select
              value={formData.role}
              onValueChange={(value) => setFormData({ ...formData, role: value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="worker">Factory Worker</SelectItem>
                <SelectItem value="qc_inspector">QC Inspector</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-sv-gray-300 uppercase tracking-wider">
              Password
            </label>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="••••••••"
                required
                minLength={8}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-sv-gray-400 hover:text-sv-white transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-md border border-sv-red/30 bg-sv-red/10 px-3 py-2 text-sm text-sv-red"
            >
              {error}
            </motion.div>
          )}

          <Button type="submit" size="lg" className="w-full mt-2" disabled={loading}>
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Creating account...</>
            ) : (
              "Create account"
            )}
          </Button>
        </form>

        <div className="mt-6 text-center">
          <span className="text-sv-gray-400 text-sm">
            Already have an account?{" "}
            <Link href="/login" className="text-sv-white hover:underline">
              Sign in
            </Link>
          </span>
        </div>
      </motion.div>
    </div>
  );
}
