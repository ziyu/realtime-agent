export const EXPRESSIONS = ['neutral', 'attentive', 'thinking', 'curious', 'pleased'] as const;
export type Expression = typeof EXPRESSIONS[number];
export type GazeTarget = 'forward' | 'speaker' | 'activity';
export interface PresentationState {
  expression: Expression;
  gaze: GazeTarget;
  faceExecutionId: string | null;
  gazeExecutionId: string | null;
}
export const expressionLabels: Record<Expression, string> = {
  neutral: '放松', attentive: '倾听', thinking: '思考', curious: '好奇', pleased: '欣喜',
};
export const initialPresentation = (): PresentationState => ({ expression: 'neutral', gaze: 'forward', faceExecutionId: null, gazeExecutionId: null });
