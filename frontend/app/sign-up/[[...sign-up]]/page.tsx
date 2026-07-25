import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";

export default function SignUpPage() {
  return (
    <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center" }}>
      {/* The Clerk widget reads dynamic auth data; stream it behind Suspense (Cache Components). */}
      <Suspense fallback={null}>
        <SignUp />
      </Suspense>
    </div>
  );
}
