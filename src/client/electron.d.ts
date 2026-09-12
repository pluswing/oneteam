export {};

declare global {
  interface Window {
    oneTeamDesktop?: {
      getDroppedPath: (file: File) => string;
      chooseDirectory: () => Promise<string | null>;
    };
  }
}
