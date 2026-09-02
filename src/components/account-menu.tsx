import { UserButton, useUser } from "@clerk/react";
import { authRouteUrl } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { isNativeApp } from "@/lib/platform";
import { useEffect, useRef } from "react";

export function AccountMenu({
  showName = false,
  compact = false,
}: {
  showName?: boolean;
  compact?: boolean;
}) {
  const { user } = useUser();
  const reloadedPolicy = useRef(false);
  useEffect(() => {
    if (!user?.deleteSelfEnabled || reloadedPolicy.current) return;
    reloadedPolicy.current = true;
    const timer = window.setTimeout(() => void user.reload(), 1_500);
    return () => window.clearTimeout(timer);
  }, [user]);
  const shared = {
    showName,
    appearance: {
      elements: {
        avatarBox: compact ? "h-10 w-10" : "h-11 w-11",
        userButtonAvatarBox: compact ? "h-10 w-10" : "h-11 w-11",
        userButtonTrigger: cn(
          "min-h-11 rounded-xl focus-visible:ring-2 focus-visible:ring-pencil",
          showName && "max-w-[190px] px-1",
        ),
        userButtonOuterIdentifier: "truncate text-sm font-semibold text-ink",
      },
    },
  };
  if (isNativeApp && user?.deleteSelfEnabled)
    return (
      <UserButton
        {...shared}
        userProfileMode="navigation"
        userProfileUrl={authRouteUrl("/settings/privacy")}
      />
    );
  return isNativeApp ? (
    <UserButton {...shared} userProfileMode="modal" />
  ) : (
    <UserButton
      {...shared}
      userProfileMode="navigation"
      userProfileUrl={authRouteUrl("/settings/profile")}
    />
  );
}
