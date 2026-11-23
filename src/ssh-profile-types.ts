export type SshProfile = {
  id: string;
  project_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  environment: "DEV" | "STAGING" | "PROD";
  revision: number;
};

export type SshOpenRequest = { profile: SshProfile; sequence: number };
