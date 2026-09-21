// happy-dom exposes a per-window helper the tests use to change the URL.
interface Window { happyDOM: { setURL(url: string): void; waitUntilComplete(): Promise<void> } }
