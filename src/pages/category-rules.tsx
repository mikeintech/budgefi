import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, Tags } from "lucide-react";
import { Link } from "react-router-dom";
import type { MerchantCategoryRulesResponse } from "@budgefi/contracts";
import { MobileShell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { api, requestId } from "@/lib/api";
import { transactionCategories } from "@/lib/transaction-categories";

type Rule = MerchantCategoryRulesResponse["rules"][number];

export function CategoryRulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState("");
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setRules((await api.transactionCategoryRules()).rules);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Rules could not be loaded",
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const save = async (rule: Rule, category: Rule["category"]) => {
    setSavingId(rule.id);
    setError("");
    try {
      setRules(
        (
          await api.updateTransactionCategoryRule(rule.id, {
            category,
            expectedVersion: rule.version,
            requestId: requestId(),
          })
        ).rules,
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Rule could not be updated",
      );
    } finally {
      setSavingId("");
    }
  };
  const remove = async (rule: Rule) => {
    setSavingId(rule.id);
    setError("");
    try {
      setRules(
        (
          await api.deleteTransactionCategoryRule(rule.id, {
            expectedVersion: rule.version,
            requestId: requestId(),
          })
        ).rules,
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Rule could not be removed",
      );
    } finally {
      setSavingId("");
    }
  };
  return (
    <MobileShell>
      <main className="px-4 pb-8 pt-5">
        <Link
          to="/activity"
          className="inline-flex min-h-11 items-center gap-2 text-sm font-bold text-pencil"
        >
          <ArrowLeft className="size-4" /> Transactions
        </Link>
        <p className="eyebrow mt-2">Automatic organization</p>
        <h1 className="text-[31px] font-bold tracking-[-0.04em]">
          Category rules
        </h1>
        <p className="mt-1 text-sm leading-5 text-muted">
          These choices categorize future transactions from the same merchant.
          Change or remove any rule here.
        </p>
        {error && (
          <div role="alert" className="mt-4 rounded-xl bg-coral/10 p-3 text-sm">
            <strong>Something went wrong.</strong>
            <p className="mt-1">{error}</p>
            <button
              className="mt-2 min-h-11 font-bold text-pencil"
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        )}
        {loading ? (
          <div className="mt-5 space-y-3" aria-label="Loading category rules">
            {[1, 2].map((item) => (
              <div
                key={item}
                className="h-24 animate-pulse rounded-2xl bg-recessed"
              />
            ))}
          </div>
        ) : rules.length === 0 ? (
          <div className="mt-5 rounded-[22px] border border-dashed border-rule bg-white p-6 text-center">
            <Tags className="mx-auto size-6 text-cobalt" />
            <strong className="mt-2 block">No category rules</strong>
            <p className="mt-1 text-sm text-muted">
              Open a transaction and choose to use its category for future
              matching merchants.
            </p>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {rules.map((rule) => (
              <section
                key={rule.id}
                className="rounded-[22px] border border-rule bg-white p-4"
              >
                <strong className="block truncate capitalize">
                  {rule.merchant}
                </strong>
                <label className="mt-3 block text-sm font-bold">
                  Future category
                  <select
                    value={rule.category}
                    disabled={savingId === rule.id}
                    onChange={(event) =>
                      void save(rule, event.target.value as Rule["category"])
                    }
                    className="mt-2 h-12 w-full rounded-xl border border-rule bg-white px-3 text-base"
                  >
                    {transactionCategories.map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  className="mt-2 w-full text-coral"
                  variant="ghost"
                  disabled={savingId === rule.id}
                  onClick={() => void remove(rule)}
                >
                  {savingId === rule.id ? (
                    <RefreshCw className="size-4 animate-spin" />
                  ) : (
                    "Remove rule"
                  )}
                </Button>
              </section>
            ))}
          </div>
        )}
      </main>
    </MobileShell>
  );
}
