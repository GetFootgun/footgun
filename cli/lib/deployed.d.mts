export interface DeployFs {
  exists(p: string): boolean;
  read(p: string): string | null;
}
export function isProdDeploy(command: string, cwd: string, fs?: DeployFs): "vercel" | "railway" | null;
export function deployHookAnswer(input: unknown, fs?: DeployFs): string | null;
