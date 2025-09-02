const { WhopServerSdk } = require('@whop/api');

export const whopSdk = WhopServerSdk({
  // App ID from your Whop dashboard
  appId: process.env.NEXT_PUBLIC_WHOP_APP_ID,
  
  // API key from your Whop dashboard
  appApiKey: process.env.WHOP_API_KEY,
  
  // Agent user ID for making requests on behalf of a user
  onBehalfOfUserId: process.env.NEXT_PUBLIC_WHOP_AGENT_USER_ID,
  
  // Company ID for requests that require it
  companyId: process.env.NEXT_PUBLIC_WHOP_COMPANY_ID,
});