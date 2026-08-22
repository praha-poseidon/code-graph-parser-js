declare function connect(state: unknown, dispatch: unknown): (component: unknown) => unknown;

type Props = {
  save: (value?: unknown) => unknown;
  cancel: () => unknown;
};

const mapDispatch = (dispatch: any) => ({
  save: (payload: unknown) => dispatch.user.save(payload),
  cancel: () => dispatch.user.cancel()
});

export function Page({ save, cancel: onCancel }: Props) {
  const flag = true;
  (flag ? save : onCancel)();
  (save || onCancel)();
  (save ?? onCancel)();
  return null;
}

export function PropsPage(props: Props) {
  const { cancel: cancelFromProps } = props;
  props.save?.();
  cancelFromProps();
  return null;
}

export function dynamic(dispatch: any, model: string, effect: string) {
  return dispatch[model][effect]();
}

export const ConnectedPage = connect(null, mapDispatch)(Page);
export const ConnectedPropsPage = connect(null, mapDispatch)(PropsPage);
