import { Navigate, Route, Routes } from "react-router-dom";
import { TodayPage } from "@/pages/today";
import { ReviewPage } from "@/pages/review";
import { ReviewCasePage } from "@/pages/review-case";
import { PlanPage } from "@/pages/plan";
import { ActivityPage } from "@/pages/activity";
import { MorePage } from "@/pages/more";
import { OnboardingPage } from "@/pages/onboarding";
import { ConnectionsPage } from "@/pages/connections";
import { SettingsDetailPage, SettingsIndexPage } from "@/pages/settings";
import { LandingPage } from "@/pages/landing";
import { ForgotPasswordPage, SignInPage, SignUpPage } from "@/pages/auth";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/sign-up" element={<SignUpPage />} />
      <Route path="/sign-in" element={<SignInPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/today" element={<TodayPage />} />
      <Route path="/review" element={<ReviewPage />} />
      <Route path="/review/:slug" element={<ReviewCasePage />} />
      <Route path="/plan" element={<PlanPage />} />
      <Route path="/activity" element={<ActivityPage />} />
      <Route path="/more" element={<MorePage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/connections" element={<ConnectionsPage />} />
      <Route path="/settings" element={<SettingsIndexPage />} />
      <Route path="/settings/:section" element={<SettingsDetailPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
