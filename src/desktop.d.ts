export {};

declare global {
  interface Window {
    /** electron/preload.ts が contextBridge で公開する API。Web では undefined。 */
    mafterDesktop?: {
      isElectron: true;
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
      isMaximized(): Promise<boolean>;
      onMaximizeChange(cb: (maximized: boolean) => void): () => void;
      postFeedback(payload: unknown): Promise<boolean>;
    };
  }
}
