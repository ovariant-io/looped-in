import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";
import { AuthScreen } from "@/app/lib/auth-screen";

export default function SignUpPage() {
  return (
    <AuthScreen>
      {/* The Clerk widget reads dynamic auth data; stream it behind Suspense (Cache Components). */}
      <Suspense fallback={null}>
        <SignUp />
      </Suspense>
    </AuthScreen>
  );
}
