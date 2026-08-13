import { NextAuthOptions } from "next-auth"
import GithubProvider from "next-auth/providers/github"

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    GithubProvider({
      clientId: process.env.AUTH_GITHUB_ID as string,
      clientSecret: process.env.AUTH_GITHUB_SECRET as string,
      authorization: { params: { scope: "read:user" } },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        
        try {
          const res = await fetch("https://api.github.com/user/installations", {
            headers: {
              Authorization: `token ${account.access_token}`,
              Accept: "application/vnd.github.v3+json",
            },
          });
          const data = await res.json();
          if (data && data.installations) {
            token.installationIds = data.installations.map((inst: any) => inst.id);
          } else {
            token.installationIds = [];
          }
        } catch (error) {
          console.error("Error fetching GitHub installations:", error);
          token.installationIds = [];
        }
      }
      return token;
    },
    async session({ session, token }) {
      (session as any).installationIds = token.installationIds || [];
      return session;
    }
  },
  pages: {
    signIn: '/login',
  }
};
