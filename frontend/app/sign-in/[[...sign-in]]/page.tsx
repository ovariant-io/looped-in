import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";
import { AuthScreen } from "@/app/lib/auth-screen";

export default function SignInPage() {
  return (
    <AuthScreen>
      {/* The Clerk widget reads dynamic auth data; stream it behind Suspense (Cache Components). */}
      <Suspense fallback={null}>
        <SignIn />
      </Suspense>
    </AuthScreen>
  );
}
