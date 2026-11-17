/**
 * Test double for @tanstack/react-query used in renderHarness lifecycle tests.
 *
 * Implements:
 * - useQuery(options)
 * - useQueryClient()
 * - useMutation(options)
 */

export function createFakeReactQuery(react) {
  let clock = 0;
  const calls = [];

  const queryClient = {
    calls,
    invalidateQueries: async (arg) => {
      calls.push({ method: "invalidateQueries", arg });
    },
    prefetchQuery: async (arg) => {
      calls.push({ method: "prefetchQuery", arg });
      if (arg?.queryFn) {
        try {
          await arg.queryFn({ queryKey: arg.queryKey, signal: new AbortController().signal });
        } catch {
          // ignore prefetch errors
        }
      }
    },
    cancelQueries: async (arg) => {
      calls.push({ method: "cancelQueries", arg });
    },
    setQueryData: (arg1, arg2) => {
      calls.push({ method: "setQueryData", arg1, arg2 });
    },
    setQueriesData: (arg1, arg2) => {
      calls.push({ method: "setQueriesData", arg1, arg2 });
    },
    getQueryData: (arg) => {
      calls.push({ method: "getQueryData", arg });
      return undefined;
    },
  };

  function useQuery(options = {}) {
    const keyString = options.queryKey ? JSON.stringify(options.queryKey) : "";
    const isEnabled = options.enabled !== false;

    const [data, setData] = react.useState(undefined);
    const [error, setError] = react.useState(null);
    const [status, setStatus] = react.useState("pending");
    const [isFetching, setIsFetching] = react.useState(false);
    const [dataUpdatedAt, setDataUpdatedAt] = react.useState(0);
    const [errorUpdatedAt, setErrorUpdatedAt] = react.useState(0);
    const [refetchSeq, setRefetchSeq] = react.useState(0);

    const refetch = react.useCallback(() => {
      setRefetchSeq((s) => s + 1);
    }, []);

    react.useEffect(() => {
      if (!isEnabled || !options.queryFn) {
        setIsFetching(false);
        return;
      }

      let active = true;
      setIsFetching(true);
      const controller = new AbortController();

      Promise.resolve()
        .then(() =>
          options.queryFn({
            queryKey: options.queryKey,
            signal: controller.signal,
          })
        )
        .then(
          (result) => {
            if (!active) return;
            const finalData =
              typeof options.select === "function" ? options.select(result) : result;
            setData(finalData);
            setError(null);
            setStatus("success");
            setIsFetching(false);
            setDataUpdatedAt(++clock);
          },
          (err) => {
            if (!active) return;
            setError(err);
            setStatus("error");
            setIsFetching(false);
            setErrorUpdatedAt(++clock);
          }
        );

      return () => {
        active = false;
        controller.abort();
      };
    }, [keyString, isEnabled, refetchSeq]);

    return {
      data,
      error,
      status,
      isPending: status === "pending",
      isError: status === "error",
      isSuccess: status === "success",
      isFetching,
      dataUpdatedAt,
      errorUpdatedAt,
      refetch,
    };
  }

  function useQueryClient() {
    return queryClient;
  }

  function useMutation(options = {}) {
    const [data, setData] = react.useState(undefined);
    const [error, setError] = react.useState(null);
    const [isPending, setIsPending] = react.useState(false);

    const mutate = react.useCallback(
      (variables) => {
        setIsPending(true);
        Promise.resolve()
          .then(() => (options.mutationFn ? options.mutationFn(variables) : undefined))
          .then(
            (res) => {
              setData(res);
              setError(null);
              setIsPending(false);
              options.onSuccess?.(res, variables);
              options.onSettled?.(res, null, variables);
            },
            (err) => {
              setError(err);
              setIsPending(false);
              options.onError?.(err, variables);
              options.onSettled?.(undefined, err, variables);
            }
          );
      },
      [options]
    );

    return {
      mutate,
      mutateAsync: async (variables) => {
        setIsPending(true);
        try {
          const res = options.mutationFn ? await options.mutationFn(variables) : undefined;
          setData(res);
          setError(null);
          setIsPending(false);
          options.onSuccess?.(res, variables);
          options.onSettled?.(res, null, variables);
          return res;
        } catch (err) {
          setError(err);
          setIsPending(false);
          options.onError?.(err, variables);
          options.onSettled?.(undefined, err, variables);
          throw err;
        }
      },
      data,
      error,
      isPending,
      isSuccess: !isPending && !error && data !== undefined,
      isError: !isPending && error !== null,
    };
  }

  return {
    __esModule: true,
    useQuery,
    useQueryClient,
    useMutation,
    QueryClient: class {
      constructor() {
        return queryClient;
      }
    },
  };
}
