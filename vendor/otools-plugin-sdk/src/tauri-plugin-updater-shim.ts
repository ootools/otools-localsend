export type Update = {
  available: false;
  downloadAndInstall: (
    onEvent?: (progress: unknown) => void,
  ) => Promise<void>;
  close: () => Promise<void>;
};

export async function check(): Promise<Update | null> {
  return null;
}
