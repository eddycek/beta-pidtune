import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PortInfo, ConnectionStatus } from '@shared/types/common.types';

// Mock useToast BEFORE importing useConnection — the hook calls
// `const toast = useToast()` and then toast.success/info/warning/error.
const { mockToastSuccess, mockToastError, mockToastInfo, mockToastWarning } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
  mockToastWarning: vi.fn(),
}));

vi.mock('./useToast', () => ({
  useToast: () => ({
    success: mockToastSuccess,
    error: mockToastError,
    info: mockToastInfo,
    warning: mockToastWarning,
  }),
}));

import { useConnection, resetConnectionGlobalState } from './useConnection';

describe('useConnection', () => {
  const mockPorts: PortInfo[] = [
    { path: '/dev/ttyUSB0', manufacturer: 'Silicon Labs' },
    { path: '/dev/ttyUSB1', manufacturer: 'FTDI' },
  ];

  const mockConnectedStatus: ConnectionStatus = {
    connected: true,
    portPath: '/dev/ttyUSB0',
    fcInfo: {
      variant: 'BTFL',
      version: '4.4.0',
      target: 'MATEKF405',
      boardName: 'MATEKF405',
      apiVersion: { protocol: 1, major: 12, minor: 0 },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(window.betaflight.listPorts).mockResolvedValue(mockPorts);
    vi.mocked(window.betaflight.getConnectionStatus).mockResolvedValue({ connected: false });
    vi.mocked(window.betaflight.connect).mockResolvedValue(undefined);
    vi.mocked(window.betaflight.disconnect).mockResolvedValue(undefined);
    vi.mocked(window.betaflight.onConnectionChanged).mockReturnValue(() => {});
  });

  it('initializes with disconnected status', async () => {
    const { result } = renderHook(() => useConnection());

    expect(result.current.status.connected).toBe(false);
  });

  it('loads initial connection status on mount', async () => {
    vi.mocked(window.betaflight.getConnectionStatus).mockResolvedValue(mockConnectedStatus);

    const { result } = renderHook(() => useConnection());

    await waitFor(() => {
      expect(result.current.status).toEqual(mockConnectedStatus);
    });
  });

  it('subscribes to connection changes on mount', () => {
    renderHook(() => useConnection());

    expect(window.betaflight.onConnectionChanged).toHaveBeenCalled();
  });

  it('scans for ports', async () => {
    const { result } = renderHook(() => useConnection());

    await result.current.scanPorts();

    await waitFor(() => {
      expect(result.current.ports).toEqual(mockPorts);
    });

    expect(window.betaflight.listPorts).toHaveBeenCalled();
  });

  it('sets loading state while scanning ports', async () => {
    vi.mocked(window.betaflight.listPorts).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(mockPorts), 100))
    );

    const { result } = renderHook(() => useConnection());

    result.current.scanPorts();

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it('connects to port successfully', async () => {
    const { result } = renderHook(() => useConnection());

    await result.current.connect('/dev/ttyUSB0');

    expect(window.betaflight.connect).toHaveBeenCalledWith('/dev/ttyUSB0');
  });

  it('sets loading state while connecting', async () => {
    vi.mocked(window.betaflight.connect).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    );

    const { result } = renderHook(() => useConnection());

    result.current.connect('/dev/ttyUSB0');

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it('disconnects successfully', async () => {
    const { result } = renderHook(() => useConnection());

    await result.current.disconnect();

    expect(window.betaflight.disconnect).toHaveBeenCalled();
  });

  it('sets loading state while disconnecting', async () => {
    vi.mocked(window.betaflight.disconnect).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    );

    const { result } = renderHook(() => useConnection());

    result.current.disconnect();

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it('sets error state when scan fails', async () => {
    const errorMessage = 'Failed to scan ports';
    vi.mocked(window.betaflight.listPorts).mockRejectedValue(new Error(errorMessage));

    const { result } = renderHook(() => useConnection());

    await result.current.scanPorts();

    await waitFor(() => {
      expect(result.current.error).toBe(errorMessage);
    });
  });

  it('sets error state when connection fails', async () => {
    const errorMessage = 'Failed to connect';
    vi.mocked(window.betaflight.connect).mockRejectedValue(new Error(errorMessage));

    const { result } = renderHook(() => useConnection());

    await result.current.connect('/dev/ttyUSB0');

    await waitFor(() => {
      expect(result.current.error).toBe(errorMessage);
    });
  });

  it('clears error when successful connection happens', async () => {
    let connectionChangeCallback: (status: ConnectionStatus) => void = () => {};
    vi.mocked(window.betaflight.onConnectionChanged).mockImplementation(
      (callback: (status: ConnectionStatus) => void) => {
        connectionChangeCallback = callback;
        return () => {};
      }
    );

    const errorMessage = 'Previous error';
    vi.mocked(window.betaflight.listPorts).mockRejectedValue(new Error(errorMessage));

    const { result } = renderHook(() => useConnection());

    await result.current.scanPorts();

    await waitFor(() => {
      expect(result.current.error).toBe(errorMessage);
    });

    // Trigger connection changed event with successful connection
    connectionChangeCallback(mockConnectedStatus);

    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });

  it('updates status when connection changed event fires', async () => {
    let connectionChangeCallback: (status: ConnectionStatus) => void = () => {};

    vi.mocked(window.betaflight.onConnectionChanged).mockImplementation(
      (callback: (status: ConnectionStatus) => void) => {
        connectionChangeCallback = callback;
        return () => {};
      }
    );

    const { result } = renderHook(() => useConnection());

    await waitFor(() => {
      expect(result.current.status.connected).toBe(false);
    });

    // Trigger connection change
    connectionChangeCallback(mockConnectedStatus);

    await waitFor(() => {
      expect(result.current.status).toEqual(mockConnectedStatus);
    });
  });

  it('shows error from connection status', async () => {
    const errorStatus: ConnectionStatus = {
      connected: false,
      error: 'Connection error from status',
    };

    let connectionChangeCallback: (status: ConnectionStatus) => void = () => {};

    vi.mocked(window.betaflight.onConnectionChanged).mockImplementation(
      (callback: (status: ConnectionStatus) => void) => {
        connectionChangeCallback = callback;
        return () => {};
      }
    );

    const { result } = renderHook(() => useConnection());

    // Trigger error in connection status
    connectionChangeCallback(errorStatus);

    await waitFor(() => {
      expect(result.current.error).toBe('Connection error from status');
    });
  });

  describe('Toast notifications', () => {
    beforeEach(() => {
      // Reset global state between tests
      resetConnectionGlobalState();

      // Clear mock call history but keep same function instances
      // (the module-level useToast mock returns these hoisted fns)
      mockToastSuccess.mockClear();
      mockToastError.mockClear();
      mockToastInfo.mockClear();
      mockToastWarning.mockClear();
    });

    it('shows success toast on successful connection', async () => {
      let connectionChangeCallback: (status: ConnectionStatus) => void = () => {};

      vi.mocked(window.betaflight.onConnectionChanged).mockImplementation(
        (callback: (status: ConnectionStatus) => void) => {
          connectionChangeCallback = callback;
          return () => {};
        }
      );

      renderHook(() => useConnection());

      // Simulate successful connection
      connectionChangeCallback(mockConnectedStatus);

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('Connected to MATEKF405');
      });
    });

    it('shows warning toast on unexpected disconnection', async () => {
      let connectionChangeCallback: (status: ConnectionStatus) => void = () => {};

      vi.mocked(window.betaflight.onConnectionChanged).mockImplementation(
        (callback: (status: ConnectionStatus) => void) => {
          connectionChangeCallback = callback;
          return () => {};
        }
      );

      renderHook(() => useConnection());

      // Let the initial getConnectionStatus() promise settle first — it writes
      // globalPreviouslyConnected and would otherwise clobber the connect event
      await act(async () => {});

      // First connect
      act(() => connectionChangeCallback(mockConnectedStatus));

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalled();
      });

      // Then disconnect unexpectedly (USB unplugged)
      act(() => connectionChangeCallback({ connected: false }));

      await waitFor(() => {
        expect(mockToastWarning).toHaveBeenCalledWith(
          'Flight controller disconnected unexpectedly'
        );
      });
    });

    it('shows info toast on intentional disconnect (button)', async () => {
      let connectionChangeCallback: (status: ConnectionStatus) => void = () => {};

      vi.mocked(window.betaflight.onConnectionChanged).mockImplementation(
        (callback: (status: ConnectionStatus) => void) => {
          connectionChangeCallback = callback;
          return () => {};
        }
      );

      const { result } = renderHook(() => useConnection());

      // Let the initial getConnectionStatus() promise settle first
      await act(async () => {});

      // First connect
      act(() => connectionChangeCallback(mockConnectedStatus));

      await waitFor(() => {
        expect(result.current.status.connected).toBe(true);
      });

      // Intentional disconnect via button (sets the intentional flag)
      await act(async () => {
        await result.current.disconnect();
      });

      // The toast is emitted by the connection-changed listener, not by
      // disconnect() itself — the backend fires the event after the port closes
      act(() => connectionChangeCallback({ connected: false }));

      await waitFor(() => {
        expect(mockToastInfo).toHaveBeenCalledWith('Disconnected');
        // Should NOT show warning toast
        expect(mockToastWarning).not.toHaveBeenCalled();
      });
    });

    it('does not show duplicate warning toasts on repeated disconnect events', async () => {
      let connectionChangeCallback: (status: ConnectionStatus) => void = () => {};

      vi.mocked(window.betaflight.onConnectionChanged).mockImplementation(
        (callback: (status: ConnectionStatus) => void) => {
          connectionChangeCallback = callback;
          return () => {};
        }
      );

      renderHook(() => useConnection());

      // Let the initial getConnectionStatus() promise settle first
      await act(async () => {});

      // First connect
      act(() => connectionChangeCallback(mockConnectedStatus));

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalled();
      });

      // Disconnect multiple times (simulating multiple events)
      act(() => {
        connectionChangeCallback({ connected: false });
        connectionChangeCallback({ connected: false });
        connectionChangeCallback({ connected: false });
        connectionChangeCallback({ connected: false });
        connectionChangeCallback({ connected: false });
      });

      await waitFor(() => {
        // Warning should only be called ONCE
        expect(mockToastWarning).toHaveBeenCalledTimes(1);
      });
    });

    it('resets disconnect flag after reconnection', async () => {
      let connectionChangeCallback: (status: ConnectionStatus) => void = () => {};

      vi.mocked(window.betaflight.onConnectionChanged).mockImplementation(
        (callback: (status: ConnectionStatus) => void) => {
          connectionChangeCallback = callback;
          return () => {};
        }
      );

      renderHook(() => useConnection());

      // Let the initial getConnectionStatus() promise settle first
      await act(async () => {});

      // First cycle: connect -> disconnect
      act(() => connectionChangeCallback(mockConnectedStatus));
      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledTimes(1);
      });

      act(() => connectionChangeCallback({ connected: false }));
      await waitFor(() => {
        expect(mockToastWarning).toHaveBeenCalledTimes(1);
      });

      // Second cycle: connect -> disconnect (should show warning again)
      act(() => connectionChangeCallback(mockConnectedStatus));
      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledTimes(2);
      });

      act(() => connectionChangeCallback({ connected: false }));
      await waitFor(() => {
        // Should show warning again (flag was reset)
        expect(mockToastWarning).toHaveBeenCalledTimes(2);
      });
    });

    it('shows error toast when connection status has error', async () => {
      let connectionChangeCallback: (status: ConnectionStatus) => void = () => {};

      vi.mocked(window.betaflight.onConnectionChanged).mockImplementation(
        (callback: (status: ConnectionStatus) => void) => {
          connectionChangeCallback = callback;
          return () => {};
        }
      );

      renderHook(() => useConnection());

      // Simulate error in connection status
      await act(async () => {
        connectionChangeCallback({
          connected: false,
          error: 'Failed to read from port',
        });
      });

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to read from port');
      });
    });
  });
});
