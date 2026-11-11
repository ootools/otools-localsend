type UnlistenFn = () => void;

type WebviewShim = {
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void | Promise<void>,
  ): Promise<UnlistenFn>;
};

export function getCurrentWebview(): WebviewShim {
  return {
    async listen<T>(_event: string, _handler: (event: { payload: T }) => void) {
      return () => {};
    },
  };
}
