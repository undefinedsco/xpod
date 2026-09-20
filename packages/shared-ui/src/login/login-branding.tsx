import { createContext, useContext, type ReactNode } from 'react'
import { DEFAULT_PRODUCT_NAME } from '../user-facing-errors'

/**
 * The name the host's product is shown under, for the shared login surface.
 *
 * The login components are shared, so none of them may assume a product name:
 * this carries the host's choice to the few places that mention the product in
 * user-facing text - an error that asks the user to restart the application, for
 * instance - without threading a prop through every nested view.
 */
const LoginProductNameContext = createContext<string>(DEFAULT_PRODUCT_NAME)

export function LoginProductNameProvider({
  productName,
  children,
}: {
  productName?: string
  children: ReactNode
}) {
  return (
    <LoginProductNameContext.Provider value={productName?.trim() || DEFAULT_PRODUCT_NAME}>
      {children}
    </LoginProductNameContext.Provider>
  )
}

export function useLoginProductName(): string {
  return useContext(LoginProductNameContext)
}
