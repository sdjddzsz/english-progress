/**
 * ErrorBoundary.tsx —— 顶层渲染错误边界（加固：渲染一旦抛错不再整页白屏）。
 *
 * 用法：main.tsx 用它包住整个 <App />（含 Router）。
 * 取舍说明：
 * - React 只有 class 组件能当错误边界（getDerivedStateFromError + componentDidCatch）；
 * - 回退 UI 刻意只用原生 HTML，不依赖 MUI / 主题——若崩溃本身来自主题或 MUI 层，
 *   用 MUI 渲染回退可能再次崩，原生元素最稳；
 * - componentDidCatch 把 error 与组件栈 console.error 出去，**不吞错**，便于定位。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 不吞错：保留到控制台（含组件栈），便于排查真实崩溃点
    console.error('[ErrorBoundary] render error:', error, info);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const error = this.state.error;
    const stackHead = error?.stack ? error.stack.split('\n').slice(0, 4).join('\n') : '';
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', lineHeight: 1.6 }}>
        <h2 style={{ margin: '0 0 8px' }}>页面出错了</h2>
        <p style={{ margin: '0 0 12px', color: '#666' }}>
          渲染过程发生错误，页面已停止以避免继续出错。可刷新重试；若反复出现，请把下方信息反馈。
        </p>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: '#f5f5f5',
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
            margin: '0 0 12px',
          }}
        >
          {error?.message ?? 'Unknown error'}
          {stackHead ? `\n${stackHead}` : ''}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: '6px 14px', cursor: 'pointer', borderRadius: 4, border: '1px solid #ccc', background: '#fff' }}
        >
          刷新页面
        </button>
      </div>
    );
  }
}
